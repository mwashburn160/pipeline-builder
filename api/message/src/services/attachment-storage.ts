// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * S3-compatible blob storage for message attachments.
 *
 * Backed by MinIO in every environment (self-hosted, no AWS-account coupling);
 * because MinIO speaks the S3 API, this uses the AWS S3 SDK so a real-S3 swap is
 * a pure config change (drop the custom endpoint + path-style, supply IAM creds).
 *
 * The client itself and the create-bucket-once backstop are api-core's shared
 * `s3-client` (`@pipeline-builder/api-core/s3`) — the same ones the plugin
 * service's build-context storage uses, so the connection config and the
 * benign-race-vs-real-outage handling cannot drift between the two. This module
 * keeps only what is message's own: the bucket, the key convention and
 * thumbnailing.
 *
 * Config (env): `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` /
 * `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` are read by the shared client;
 * `S3_BUCKET` (default 'message-attachments') is read here.
 */

import { Readable } from 'node:stream';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createLogger, emitCounter, envStr, envInt } from '@pipeline-builder/api-core';
import { ensureBucket, s3Client } from '@pipeline-builder/api-core/s3';
import { Jimp } from 'jimp';

const logger = createLogger('attachment-storage');

/** Resolved bucket name — the single bucket all attachment blobs live in. */
export const ATTACHMENT_BUCKET = envStr('S3_BUCKET', 'message-attachments');

/** Max long-edge (px) of a generated thumbnail. Env-overridable. */
export const THUMB_MAX_DIM = Math.max(48, envInt('MESSAGE_THUMBNAIL_MAX_DIM', 320));

/**
 * The thumbnail sibling of a full storage key (`…/<file>` → `…/thumb`), and the
 * ONE way any caller names a thumbnail.
 *
 * A blob's path segment is a uuid minted locally for the storage key, NOT the
 * attachment row's id (which the database assigns on insert), so a thumbnail
 * named from the row id would be looked for at a path it was never written to
 * and `?thumb=1` would silently serve the full-size original. Deriving it from
 * the storage key everywhere — upload, download and purge — keeps them in step.
 */
export function thumbnailSiblingOf(storageKey: string): string {
  const i = storageKey.lastIndexOf('/');
  return i >= 0 ? `${storageKey.slice(0, i)}/thumb` : `${storageKey}.thumb`;
}

/** Content-type a thumbnail is stored/served as (PNG preserves alpha, else JPEG). */
export function thumbnailContentType(originalContentType: string): string {
  return originalContentType === 'image/png' ? 'image/png' : 'image/jpeg';
}

/** Store a blob. Key convention: `<orgId>/<attachmentId>/<filename>`. */
export async function putAttachment(key: string, body: Buffer, contentType: string): Promise<void> {
  await ensureBucket(ATTACHMENT_BUCKET);
  await s3Client().send(new PutObjectCommand({
    Bucket: ATTACHMENT_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

/** Fetch a blob as a Node stream (for piping to the HTTP response). */
export async function getAttachmentStream(key: string): Promise<Readable> {
  const out = await s3Client().send(new GetObjectCommand({ Bucket: ATTACHMENT_BUCKET, Key: key }));
  // In Node the SDK returns a Readable; narrow the union.
  return out.Body as Readable;
}

/** Like {@link getAttachmentStream} but returns null instead of throwing when
 *  the key is absent (or any fetch error) — used for the thumbnail path, which
 *  falls back to the original blob when no thumbnail exists. */
export async function getAttachmentStreamOrNull(key: string): Promise<Readable | null> {
  try {
    return await getAttachmentStream(key);
  } catch {
    return null;
  }
}

/**
 * Generate a downscaled thumbnail (≤ {@link THUMB_MAX_DIM} on the long edge) from
 * an image buffer using PURE-JS jimp (no native deps — the alpine service image
 * needs no libvips). Returns null when:
 *  - the image is already within the thumbnail box (no point upscaling), or
 *  - it can't be decoded (e.g. webp — the default jimp codecs don't cover it),
 * so the caller just serves the original. NEVER throws — thumbnailing is
 * best-effort and must never fail an upload.
 */
export async function generateThumbnail(buffer: Buffer, contentType: string): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const img = await Jimp.read(buffer);
    if (img.width <= THUMB_MAX_DIM && img.height <= THUMB_MAX_DIM) return null;
    img.scaleToFit({ w: THUMB_MAX_DIM, h: THUMB_MAX_DIM });
    const outType = thumbnailContentType(contentType);
    const body = await img.getBuffer(outType as 'image/jpeg' | 'image/png');
    return { body: Buffer.from(body), contentType: outType };
  } catch (err) {
    logger.warn('Thumbnail generation failed (will serve original)', { error: String(err) });
    return null;
  }
}

/** Best-effort single-object delete — never throws (blob cleanup is housekeeping). */
export async function deleteAttachment(key: string): Promise<void> {
  try {
    await s3Client().send(new DeleteObjectCommand({ Bucket: ATTACHMENT_BUCKET, Key: key }));
  } catch (err) {
    logger.warn('Attachment blob delete failed (leaving orphan)', { key, error: String(err) });
  }
}

/** S3 `DeleteObjects` accepts at most 1000 keys per request; a larger request is
 *  rejected WHOLESALE (MalformedXML), so every bulk delete must be chunked. */
export const DELETE_OBJECTS_MAX_KEYS = 1000;

/**
 * Delete `keys` in ≤{@link DELETE_OBJECTS_MAX_KEYS} batches and return the keys
 * that were NOT deleted. `DeleteObjects` reports per-key failures in `Errors`
 * while still answering 200, so the response must be inspected — a resolved
 * send is not success. A thrown batch, or an `Errors` entry that names no key,
 * marks the whole batch failed (re-deleting an already-deleted key is a no-op,
 * so over-reporting only costs a redundant retry). Never throws.
 */
async function deleteKeysOnce(keys: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < keys.length; i += DELETE_OBJECTS_MAX_KEYS) {
    const batch = keys.slice(i, i + DELETE_OBJECTS_MAX_KEYS);
    try {
      const out = await s3Client().send(new DeleteObjectsCommand({
        Bucket: ATTACHMENT_BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
      const errors = out?.Errors ?? [];
      if (errors.some((e) => !e.Key)) failed.push(...batch);
      else for (const e of errors) failed.push(e.Key as string);
    } catch (err) {
      logger.warn('Attachment bulk delete batch failed', { count: batch.length, error: String(err) });
      failed.push(...batch);
    }
  }
  return failed;
}

export interface DeleteAttachmentsOptions {
  /** Total attempts for keys that failed to delete (default 3). */
  attempts?: number;
  /** Linear backoff base between attempts, in ms (default 250). */
  retryDelayMs?: number;
}

/**
 * Bulk blob delete for cascade cleanup. Each key's thumbnail sibling is deleted
 * alongside it (deleting an absent thumb key is a no-op in S3/MinIO), so image
 * thumbnails never orphan on a purge. Batched to the DeleteObjects cap, per-key
 * `Errors` honoured, and failed keys retried with backoff. Never throws —
 * callers invoke this only AFTER the metadata rows are committed gone (see
 * MessageService.onAfterPurge / AttachmentService.purgePending), so a blob that
 * still fails is an orphan (storage leak, logged + counted), never a dangling
 * row pointing at a missing blob. Returns the keys that could not be deleted.
 */
export async function deleteAttachments(keys: string[], opts: DeleteAttachmentsOptions = {}): Promise<string[]> {
  if (keys.length === 0) return [];
  const attempts = Math.max(1, opts.attempts ?? 3);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 250);
  let pending = [...new Set(keys.flatMap((k) => [k, thumbnailSiblingOf(k)]))];
  for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt += 1) {
    if (attempt > 1 && retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs * (attempt - 1)));
    pending = await deleteKeysOnce(pending);
  }
  if (pending.length > 0) {
    logger.warn('Attachment blobs left orphaned after retries', { count: pending.length, sample: pending.slice(0, 5) });
    emitCounter('message_attachment_blob_orphans_total', {}, pending.length);
  }
  return pending;
}

/**
 * Delete EVERY blob under an org's key prefix (`<orgId>/…`) — the org-purge
 * cleanup the platform cascade can't do itself (it hard-deletes the
 * `message_attachments` metadata rows but holds no object-storage client, so the
 * blobs would orphan). Lists + bulk-deletes in pages of 1000 (the S3
 * ListObjectsV2 / DeleteObjects cap), returning the count removed.
 *
 * UNLIKE the best-effort single/bulk deletes, a page failure THROWS so the
 * caller (the internal purge route) can surface a non-2xx and the cascade can
 * treat blob cleanup as incomplete — a silent partial purge is how orphans
 * accumulate unnoticed. The orgId is lower-cased to match the write-side key.
 */
export async function deleteAttachmentsByOrgPrefix(orgId: string): Promise<number> {
  // Trailing slash so `org-1/` never matches `org-10/…` (prefix over-match).
  const prefix = `${orgId.toLowerCase()}/`;
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await s3Client().send(new ListObjectsV2Command({
      Bucket: ATTACHMENT_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string');
    if (objects.length > 0) {
      // ListObjectsV2 pages are ≤1000 keys, but DeleteObjects still reports
      // per-key failures in `Errors` on a 200 — count those as a failed page.
      const out = await s3Client().send(new DeleteObjectsCommand({
        Bucket: ATTACHMENT_BUCKET,
        Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
      }));
      const errors = out?.Errors ?? [];
      if (errors.length > 0) {
        throw new Error(`Failed to delete ${errors.length} of ${objects.length} attachment blobs under ${prefix}`);
      }
      deleted += objects.length;
    }
    // IsTruncated ⇒ more pages; carry the token forward.
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  logger.info('Purged attachment blobs by org prefix', { orgId: prefix, deleted });
  return deleted;
}
