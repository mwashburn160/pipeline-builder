// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Kept plugin build sources on RustFS (the `plugin-sources` bucket,
 * `PLUGIN_SOURCES_BUCKET`): the copy every version built from a ZIP keeps for
 * its whole life, so a remediation can rebuild it later.
 *
 * Layout (api-core `pluginSourceKey` and friends):
 *
 *   <orgId>/<pluginId>/<version>/<sha256>.zip      a version's build context
 *   <orgId>/<pluginId>/<version>/remediations/…    patched ZIPs, diffs, exports
 *   listings/<listingId>/<version>/<sha256>.zip    a listed version's own copy
 *
 * - {@link keepPluginSource}: when a build is stored as a version, its staged
 *   ZIP (`plugins/<orgId>/<requestId>.zip`) is hashed and copied server-side
 *   into the version's prefix BEFORE the staging object is deleted. Prebuilt
 *   image uploads keep nothing (`source_kind = 'none'`).
 * - {@link fetchPluginSource}: download for a rebuild, verified against
 *   `source_sha256`. A mismatch fails closed ({@link PluginSourceChecksumError},
 *   `plugin_source_checksum_mismatch_total`, alerted); an object that is gone
 *   (a backup restored without it) makes the version source-less, so it is not
 *   retried every night, and counts `plugin_source_missing_total`, alerted.
 * - {@link deletePluginSourcePrefix}: a purge deletes the version's whole
 *   prefix. A failed delete never blocks the purge: it lands in
 *   `plugin_source_orphans`, counts `plugin_source_delete_failures_total`, and
 *   the purge sweep retries it ({@link retryPluginSourceOrphans}).
 * - {@link deleteOrgSources}: the org purge deletes `<orgId>/` and THROWS on
 *   failure, so the purge leg is retried before the org's orphan rows go.
 *
 * Nothing here ever returns, logs or labels a source's content; logs carry
 * keys and error names only. No route serves a source ZIP.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  createLogger, errorMessage, listingSourceKey, PLUGIN_REMEDIATION_METRICS, pluginSourceKey, pluginSourceOrgPrefix,
  type PluginSourceKind, type PluginSourceOrphanKind,
} from '@pipeline-builder/api-core';
import { ensureBucket, s3Client } from '@pipeline-builder/api-core/s3';
import { incCounter } from '@pipeline-builder/api-server';
import { executeRows, runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

// Namespace import: suites mocking artifact storage with only what they use still link.
import * as artifactStorage from './plugin-artifact-storage.js';
import { remediationConfig } from '../config.js';
import { recordAutoRemovalSkip } from '../helpers/auto-removal.js';

const logger = createLogger('plugin-sources');

/** The bucket kept sources and remediation artifacts live in. */
export function pluginSourcesBucket(): string {
  return remediationConfig().sourcesBucket;
}

/** Elevated: source pointers and orphans are written by workers acting for any org, keyed by row id. */
type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];
function elevated<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
}

/** The S3 error name (NoSuchKey, AccessDenied, …), never its message or body. */
function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return (typeof name === 'string' && name ? name : 'Error').slice(0, 255);
}

function isMissingObject(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

/** A hashing pass-through: counts bytes and digests them as they stream by. */
function hasher(): { stream: Transform; digest: () => { sha256: string; sizeBytes: number } } {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      cb(null, chunk);
    },
  });
  return { stream, digest: () => ({ sha256: hash.digest('hex'), sizeBytes }) };
}

// -----------------------------------------------------------------------------
// Keeping a version's source
// -----------------------------------------------------------------------------

/** A kept source: where it is, its SHA-256 and its size. */
export interface KeptSource {
  key: string;
  sha256: string;
  sizeBytes: number;
}

/** The five source pointer columns, as the `plugins` / `plugin_listing_versions` rows store them. */
export interface SourceColumns {
  sourceKey: string | null;
  sourceSha256: string | null;
  sourceSizeBytes: number | null;
  sourceKind: PluginSourceKind;
  sourceKeptAt: Date | null;
}

/** The columns for a kept source, or the source-less ones (`none`) for null. */
export function sourceColumns(kept: KeptSource | null, keptAt: Date = new Date()): SourceColumns {
  return kept
    ? { sourceKey: kept.key, sourceSha256: kept.sha256, sourceSizeBytes: kept.sizeBytes, sourceKind: 'zip', sourceKeptAt: keptAt }
    : { sourceKey: null, sourceSha256: null, sourceSizeBytes: null, sourceKind: 'none', sourceKeptAt: null };
}

/**
 * Hash `bucket/key` by streaming it once, and return the ETag it was read at,
 * so the copy that follows can insist on the very object that was hashed.
 */
async function hashObject(bucket: string, key: string): Promise<{ sha256: string; sizeBytes: number; etag: string | undefined }> {
  const out = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const h = hasher();
  await pipeline(out.Body as Readable, h.stream, async (source: AsyncIterable<Buffer>) => {
    for await (const _chunk of source) { /* hashed in transit */ }
  });
  return { ...h.digest(), etag: out.ETag };
}

/** Server-side copy, pinned to the ETag the bytes were hashed at. */
async function copyObject(from: { bucket: string; key: string; etag?: string }, toKey: string): Promise<void> {
  const bucket = pluginSourcesBucket();
  await ensureBucket(bucket);
  await s3Client().send(new CopyObjectCommand({
    Bucket: bucket,
    Key: toKey,
    CopySource: `${from.bucket}/${from.key.split('/').map(encodeURIComponent).join('/')}`,
    ...(from.etag ? { CopySourceIfMatch: from.etag } : {}),
    ContentType: 'application/zip',
    MetadataDirective: 'REPLACE',
  }));
}

/**
 * Copy a stored version's staged build ZIP into its kept-source key,
 * `<orgId>/<pluginId>/<version>/<sha256>.zip`. Throws when it can't (the
 * caller decides — the build tail stores the version source-less and alerts).
 */
export async function keepPluginSource(input: { orgId: string; pluginId: string; version: string; stagingKey: string }): Promise<KeptSource> {
  const staged = await hashObject(artifactStorage.PLUGIN_ARTIFACT_BUCKET, input.stagingKey);
  const key = pluginSourceKey(input.orgId, input.pluginId, input.version, staged.sha256);
  await copyObject({ bucket: artifactStorage.PLUGIN_ARTIFACT_BUCKET, key: input.stagingKey, etag: staged.etag }, key);
  return { key, sha256: staged.sha256, sizeBytes: staged.sizeBytes };
}

/**
 * A listed version's own copy of its source plugin version's kept source
 * (`listings/<listingId>/<version>/<sha256>.zip`), for the publish path to
 * store on `plugin_listing_versions`. Source-less when the org version has none;
 * a failed copy is logged, counted and leaves the listing version source-less.
 */
export async function keepListingSource(input: {
  listingId: string;
  version: string;
  from: { sourceKey: string | null; sourceSha256: string | null; sourceSizeBytes: number | null; sourceKind: PluginSourceKind | string };
}): Promise<SourceColumns> {
  const { from } = input;
  if (from.sourceKind !== 'zip' || !from.sourceKey || !from.sourceSha256 || from.sourceSizeBytes == null) return sourceColumns(null);
  const key = listingSourceKey(input.listingId, input.version, from.sourceSha256);
  try {
    await copyObject({ bucket: pluginSourcesBucket(), key: from.sourceKey }, key);
    return sourceColumns({ key, sha256: from.sourceSha256, sizeBytes: from.sourceSizeBytes });
  } catch (err) {
    incCounter('plugin_source_missing_total', { reason: 'keep_failed' });
    logger.error('Could not copy a listed version\'s kept source; the listing version is stored source-less', {
      listingId: input.listingId, version: input.version, error: errorName(err),
    });
    return sourceColumns(null);
  }
}

/**
 * Write a version's source pointer. Returns the key the row held before, so a
 * re-upload of the same version can drop the source it replaced.
 */
export async function recordVersionSource(pluginId: string, kept: KeptSource | null): Promise<string | null> {
  const p = schema.plugin;
  return elevated(async (tx) => {
    const [before] = await tx.select({ sourceKey: p.sourceKey }).from(p).where(eq(p.id, pluginId));
    await tx.update(p).set(sourceColumns(kept)).where(eq(p.id, pluginId));
    return (before?.sourceKey as string | null | undefined) ?? null;
  });
}

/**
 * Keep a freshly stored version's source (or record that it has none) — the
 * build success tail's one call. A version whose ZIP could not be kept is
 * stored source-less, logged and counted (`plugin_source_missing_total
 * {reason="keep_failed"}`, alerted): the build itself succeeded, and failing it
 * now would re-run the whole build to fix a storage blip.
 */
export async function keepVersionSource(input: {
  orgId: string; pluginId: string; version: string; stagingKey: string | null;
}): Promise<KeptSource | null> {
  let kept: KeptSource | null = null;
  if (input.stagingKey) {
    try {
      kept = await keepPluginSource({ ...input, stagingKey: input.stagingKey });
    } catch (err) {
      incCounter('plugin_source_missing_total', { reason: 'keep_failed' });
      logger.error('Could not keep the build source; the version is stored source-less (overlay-only remediation)', {
        orgId: input.orgId, pluginId: input.pluginId, version: input.version, error: errorName(err),
      });
    }
  }
  // A re-upload of the same version under new content leaves the ZIP it
  // replaced in the version's prefix: source objects are only ever deleted by
  // an explicit purge of the version (prefix delete) or the org purge, never
  // as a side effect (helpers/auto-removal.ts).
  await recordVersionSource(input.pluginId, kept);
  return kept;
}

// -----------------------------------------------------------------------------
// Reading a kept source
// -----------------------------------------------------------------------------

/** A downloaded source whose SHA-256 is not the one recorded: never built from. */
export class PluginSourceChecksumError extends Error {
  readonly code = 'SOURCE_CHECKSUM_MISMATCH';
  constructor(readonly key: string, readonly expected: string, readonly actual: string) {
    super(`Kept source ${key} failed its checksum (expected ${expected}, got ${actual})`);
    this.name = 'PluginSourceChecksumError';
  }
}

/** The fields {@link fetchPluginSource} reads; `id` (+ `listingId` for a listed version) enables the missing-source fallback. */
export interface SourceRow {
  id?: string;
  orgId?: string;
  listingId?: string;
  sourceKey: string | null;
  sourceSha256: string | null;
  sourceKind: PluginSourceKind | string;
}

/**
 * Download a version's kept source to `destPath`, verified against its
 * `source_sha256`.
 *
 * - `'ok'`: the file is there and its hash matches.
 * - `'missing'`: the version has no kept source, or its object is gone. A gone
 *   object (a backup restored without it) makes the row source-less — so
 *   remediation goes overlay-only instead of failing every night — and alerts
 *   (`plugin_source_missing_total{reason="missing"}`).
 * - throws {@link PluginSourceChecksumError} on a mismatch: the file is
 *   removed, `plugin_source_checksum_mismatch_total` counts it (alerted), and
 *   the caller fails closed. Any other error propagates (retryable).
 */
export async function fetchPluginSource(row: SourceRow, destPath: string): Promise<'ok' | 'missing'> {
  if (row.sourceKind !== 'zip' || !row.sourceKey || !row.sourceSha256) return 'missing';
  let body: Readable;
  try {
    const out = await s3Client().send(new GetObjectCommand({ Bucket: pluginSourcesBucket(), Key: row.sourceKey }));
    body = out.Body as Readable;
  } catch (err) {
    if (!isMissingObject(err)) throw err;
    await markPluginSourceMissing(row);
    return 'missing';
  }
  const h = hasher();
  await pipeline(body, h.stream, fs.createWriteStream(destPath));
  const { sha256 } = h.digest();
  if (sha256 !== row.sourceSha256) {
    await rm(destPath, { force: true });
    incCounter('plugin_source_checksum_mismatch_total', {});
    logger.error('Kept source failed its checksum; refusing to build from it', {
      pluginId: row.id ?? null, listingId: row.listingId ?? null, key: row.sourceKey, expected: row.sourceSha256, actual: sha256,
    });
    throw new PluginSourceChecksumError(row.sourceKey, row.sourceSha256, sha256);
  }
  return 'ok';
}

/**
 * A kept source whose object is gone: the row becomes source-less and the
 * loss alerts. Best-effort on the row write (logged); the count always lands.
 */
export async function markPluginSourceMissing(row: SourceRow): Promise<void> {
  incCounter('plugin_source_missing_total', { reason: 'missing' });
  logger.error('Kept source is missing (restored without it?); the version is now source-less, overlay-only', {
    pluginId: row.id ?? null, listingId: row.listingId ?? null, key: row.sourceKey,
  });
  if (!row.id) return;
  try {
    await elevated(async (tx) => {
      if (row.listingId) {
        await tx.update(schema.pluginListingVersion).set(sourceColumns(null)).where(eq(schema.pluginListingVersion.id, row.id!));
      } else {
        await tx.update(schema.plugin).set(sourceColumns(null)).where(eq(schema.plugin.id, row.id!));
      }
    });
  } catch (err) {
    logger.warn('Could not mark a missing kept source source-less', { pluginId: row.id, error: errorMessage(err) });
  }
}

// -----------------------------------------------------------------------------
// Remediation artifacts
// -----------------------------------------------------------------------------

/** Store a remediation artifact (patched ZIP, diff, export) under the sources bucket. Throws on failure. */
export async function putRemediationArtifact(key: string, body: Buffer | string): Promise<void> {
  const bucket = pluginSourcesBucket();
  await ensureBucket(bucket);
  await s3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: key.endsWith('.zip') ? 'application/zip' : 'text/x-diff',
  }));
}

// -----------------------------------------------------------------------------
// Deleting
// -----------------------------------------------------------------------------

/** Keys at most one DeleteObjects call takes. */
const DELETE_BATCH = 1000;

/**
 * Delete every object under `prefix` in `bucket`. Throws on the first failure.
 * Each round lists from the START of the prefix again: what the previous round
 * deleted is gone, so no continuation token is ever carried across a delete.
 */
async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  if (!prefix.endsWith('/') || prefix.length < 2) throw new Error(`Refusing to delete a non-directory prefix "${prefix}"`);
  let deleted = 0;
  for (;;) {
    const page = await s3Client().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: DELETE_BATCH }));
    const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => typeof k === 'string');
    if (keys.length === 0) return deleted;
    const out = await s3Client().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
    const failed = out.Errors ?? [];
    if (failed.length > 0) {
      throw Object.assign(new Error(`${failed.length} object(s) under ${prefix} were not deleted`), { name: failed[0]?.Code ?? 'DeleteObjectsError' });
    }
    deleted += keys.length;
  }
}

/** An orphan to record (or re-record) after a failed delete. */
export interface SourceOrphanInput {
  orgId: string;
  kind: PluginSourceOrphanKind;
  bucket: string;
  target: string;
  pluginId?: string | null;
  pluginVersion?: string | null;
  error: unknown;
}

/**
 * Record a delete that failed so the purge sweep retries it: upserted on
 * (org, kind, bucket, target) with `attempts + 1`, counted in
 * `plugin_source_delete_failures_total{kind}`. Never throws — losing the row
 * is logged (the alert still fires off the counter).
 */
export async function recordSourceOrphan(o: SourceOrphanInput): Promise<void> {
  incCounter(PLUGIN_REMEDIATION_METRICS.sourceDeleteFailures, { kind: o.kind });
  const lastError = errorName(o.error);
  logger.warn('Delete failed; recorded for the purge sweep to retry', { orgId: o.orgId, kind: o.kind, bucket: o.bucket, target: o.target, error: lastError });
  const t = schema.pluginSourceOrphan;
  try {
    await elevated((tx) => tx.insert(t).values({
      orgId: o.orgId.toLowerCase(),
      kind: o.kind,
      bucket: o.bucket,
      target: o.target,
      pluginId: o.pluginId ?? null,
      pluginVersion: o.pluginVersion ?? null,
      lastError,
    }).onConflictDoUpdate({
      target: [t.orgId, t.kind, t.bucket, t.target],
      set: { attempts: sql`${t.attempts} + 1`, lastError, lastAttemptAt: new Date() },
    }));
  } catch (err) {
    logger.error('Could not record a failed delete for retry', { orgId: o.orgId, kind: o.kind, target: o.target, error: errorMessage(err) });
  }
}

/** Forget an orphan once its delete succeeded. */
async function clearSourceOrphan(orgId: string, kind: PluginSourceOrphanKind, bucket: string, target: string): Promise<void> {
  const t = schema.pluginSourceOrphan;
  await elevated((tx) => tx.delete(t).where(and(eq(t.orgId, orgId.toLowerCase()), eq(t.kind, kind), eq(t.bucket, bucket), eq(t.target, target))));
}

/**
 * Delete a version's kept-source prefix (`<orgId>/<pluginId>/<version>/`: the
 * source ZIP, patched ZIPs, diffs and exports). Never throws: a failure is
 * recorded as a `prefix` orphan for the sweep.
 */
export async function deletePluginSourcePrefix(input: { orgId: string; pluginId?: string | null; version?: string | null; prefix: string }): Promise<void> {
  const bucket = pluginSourcesBucket();
  try {
    await deletePrefix(bucket, input.prefix);
  } catch (err) {
    await recordSourceOrphan({ orgId: input.orgId, kind: 'prefix', bucket, target: input.prefix, pluginId: input.pluginId, pluginVersion: input.version, error: err });
  }
}

/** Delete one kept object (a replaced source). Never throws: a failure is an `object` orphan. */
export async function deletePluginSourceObject(input: { orgId: string; pluginId?: string | null; version?: string | null; key: string }): Promise<void> {
  const bucket = pluginSourcesBucket();
  try {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: input.key }));
  } catch (err) {
    await recordSourceOrphan({ orgId: input.orgId, kind: 'object', bucket, target: input.key, pluginId: input.pluginId, pluginVersion: input.version, error: err });
  }
}

/**
 * The org purge: delete everything under `<orgId>/`. THROWS on failure — the
 * purge leg must not ack (its tables, orphan rows included, would go while the
 * objects stay).
 */
export async function deleteOrgSources(orgId: string): Promise<number> {
  return deletePrefix(pluginSourcesBucket(), pluginSourceOrgPrefix(orgId));
}

/**
 * Whether a live (non-deleted) version — an org row or a listed version —
 * still points at `target` (the key itself, or a key under the prefix).
 */
async function sourceStillReferenced(bucket: string, kind: PluginSourceOrphanKind, target: string): Promise<boolean> {
  if (bucket !== pluginSourcesBucket()) return false;
  const match = kind === 'prefix'
    ? (col: SQL) => sql`starts_with(${col}, ${target})`
    : (col: SQL) => sql`${col} = ${target}`;
  const rows = await elevated((tx) => executeRows(tx, sql`
    SELECT 1 FROM plugins WHERE deleted_at IS NULL AND ${match(sql`source_key`)}
    UNION ALL
    SELECT 1 FROM plugin_listing_versions WHERE ${match(sql`source_key`)}
    LIMIT 1`));
  return rows.length > 0;
}

/** A retry handler per orphan kind, injected for `image` (version-purge.ts owns the registry call). */
export type OrphanRetry = (orphan: typeof schema.pluginSourceOrphan.$inferSelect) => Promise<void>;

/**
 * The purge sweep's retry of failed deletes: the `limit` least recently tried
 * orphans, each deleted again. A success removes the row; a failure bumps its
 * attempts (and counts again, so a stuck delete keeps the alert firing).
 * `retryImage` handles `image` orphans; without it they are left for a caller
 * that has one.
 */
export async function retryPluginSourceOrphans(opts: { limit?: number; retryImage?: OrphanRetry } = {}): Promise<{ tried: number; cleared: number; failed: number }> {
  const t = schema.pluginSourceOrphan;
  const rows = await elevated((tx) => tx.select().from(t).orderBy(asc(t.lastAttemptAt)).limit(opts.limit ?? 100));
  let cleared = 0;
  let failed = 0;
  let tried = 0;
  for (const row of rows) {
    if (row.kind === 'image' && !opts.retryImage) continue;
    // Automatic: never delete a kept source a live version still points to
    // (a version restored, or re-uploaded, since the delete failed).
    if (row.kind !== 'image' && await sourceStillReferenced(row.bucket, row.kind, row.target)) {
      recordAutoRemovalSkip('active', { path: 'orphan-retry', orgId: row.orgId, version: row.pluginVersion ?? undefined });
      await clearSourceOrphan(row.orgId, row.kind, row.bucket, row.target);
      continue;
    }
    tried++;
    try {
      if (row.kind === 'prefix') await deletePrefix(row.bucket, row.target);
      else if (row.kind === 'object') await s3Client().send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.target }));
      else await opts.retryImage!(row);
      await clearSourceOrphan(row.orgId, row.kind, row.bucket, row.target);
      cleared++;
    } catch (err) {
      failed++;
      await recordSourceOrphan({ orgId: row.orgId, kind: row.kind, bucket: row.bucket, target: row.target, pluginId: row.pluginId, pluginVersion: row.pluginVersion, error: err });
    }
  }
  if (tried > 0) logger.info('Retried failed source and image deletes', { tried, cleared, failed });
  return { tried, cleared, failed };
}

// -----------------------------------------------------------------------------
// Storage accounting
// -----------------------------------------------------------------------------

/**
 * Bytes of kept sources an org holds: every version row, live or soft-deleted
 * (a tombstone keeps its source for the restore window). What the storage view
 * adds to the registry's figure.
 */
export async function orgSourceBytes(orgId: string): Promise<number> {
  const p = schema.plugin;
  const [row] = await withTenantTx((tx) => tx
    .select({ bytes: sql<string | number | null>`COALESCE(SUM(${p.sourceSizeBytes}), 0)` })
    .from(p)
    .where(eq(p.orgId, orgId.toLowerCase())));
  return Number(row?.bytes ?? 0);
}

/** Kept-source bytes per version id of one org (rows without a kept source are absent). */
export async function sourceBytesByVersion(orgId: string): Promise<Map<string, { name: string; version: string; bytes: number }>> {
  const p = schema.plugin;
  const rows = await withTenantTx((tx) => tx
    .select({ id: p.id, name: p.name, version: p.version, bytes: p.sourceSizeBytes })
    .from(p)
    .where(and(eq(p.orgId, orgId.toLowerCase()), eq(p.sourceKind, 'zip'))));
  return new Map(rows.map((r) => [String(r.id), { name: String(r.name), version: String(r.version), bytes: Number(r.bytes ?? 0) }]));
}
