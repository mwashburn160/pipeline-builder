// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Kept setup images (docs/plugin-publishing.md "Scan gates").
 *
 * A build the scan gates refuse has its signed image REMOVED again (the build
 * worker's `discardRefusedImage`) — with ONE exception: an image from the setup
 * catalog load. The Official catalog is loaded once, at install, by
 * deploy/bin/load-plugin-worker.sh with `setupLoad=true`; a Critical published
 * the week before an install would otherwise leave that plugin missing until
 * someone rebuilt it. Such an image is KEPT, recorded here, and can be promoted
 * to a version WITHOUT a rebuild once the reason is gone — a fixed upstream
 * advisory, or an operator's advisory-id waiver (`PLUGIN_VULN_WAIVERS`).
 *
 *  - The marker is honoured for a SYSTEM-ORG build only. A tenant setting it
 *    gets the normal discard; it can never keep a refused image.
 *  - Promotion re-runs the CURRENT gates — signature, signed SBOM, a fresh
 *    vulnerability DB, the floor with today's waivers / VEX / KEV rules, the
 *    post-build compliance rules — and stores the version through the build's
 *    own success path (`persistVersion`). Still refused: 409, the row stays.
 *  - A kept image expires after `PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS` (30): the
 *    rescan scheduler's tick discards it from the registry and drops the row.
 *    A later build of the same name+version that PASSES supersedes it the same
 *    way.
 */

import {
  AppError, ErrorCode, SYSTEM_ACTOR_ID, createLogger, envInt, errorMessage, isSystemOrgId, recordAudit, type WriteAccess,
} from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, schema, withTenantTx, type PluginKeptSetupImage } from '@pipeline-builder/pipeline-data';
import { and, asc, count, eq, lte, ne } from 'drizzle-orm';

import { persistVersion } from './version-persist.js';
import type { BuildResult } from '../helpers/docker-build.js';
import { establishImageFacts } from '../helpers/image-facts.js';
import { complianceRefusal, vulnFloor, type GateEmit } from '../helpers/image-gates.js';
import type { PluginRecordData, PublishCaller } from '../helpers/plugin-helpers.js';
import { imageRepository, type RegistryInfo } from '../helpers/registry-auth.js';
import { discardPluginImage, ImageVerificationError, verifyImageSignature } from '../helpers/supply-chain.js';
import { assertVulnDbFresh, VulnDbStaleError } from '../helpers/vuln-scan.js';

const logger = createLogger('kept-setup-images');

/** `PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS` (default 30): how long a kept setup image waits for promotion. */
export function keptSetupImageTtlDays(): number {
  return envInt('PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS', 30, { min: 1 });
}

/** Whether a build's `setupLoad` marker is honoured: only for the system org. */
export function honoursSetupLoad(orgId: string, setupLoad: boolean | undefined): boolean {
  return setupLoad === true && isSystemOrgId(orgId);
}

/** The findings a refusal carries (the floor's; none for a compliance block). */
function refusalFindings(refusal: AppError): unknown[] {
  const findings = refusal.details?.findings;
  return Array.isArray(findings) ? findings : [];
}

/** What a kept image needs to become a version exactly as its build would have made it. */
export interface KeptBuild {
  userId: string;
  access: WriteAccess;
  pluginRecord: PluginRecordData;
  publish?: { caller: PublishCaller };
}

/**
 * Record a refused setup image as kept (or refresh the record when the same
 * image is refused again: newer refusal, fresh expiry). Throws on a write
 * failure — the caller decides (the build worker then discards the image, so a
 * kept image always has its row).
 */
export async function keepSetupImage(input: {
  orgId: string;
  image: { imageDigest: string; imageSource: BuildResult['imageSource'] };
  refusal: AppError;
  build: KeptBuild;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const T = schema.pluginKeptSetupImage;
  const findings = refusalFindings(input.refusal);
  const values = {
    refusalCode: input.refusal.code,
    refusalMessage: input.refusal.message,
    refusalFindings: findings,
    // The quota slot of the refused build was refunded: a promoted version
    // charges none, so it must not carry that period for a later refund.
    build: { ...input.build, pluginRecord: { ...input.build.pluginRecord, quotaResetAt: null } } as unknown as Record<string, unknown>,
    keptBy: input.build.userId,
    keptAt: now,
    expiresAt: new Date(now.getTime() + keptSetupImageTtlDays() * 86_400_000),
  };
  const [row] = await withTenantTx((tx) => tx.insert(T)
    .values({
      orgId: input.orgId,
      pluginName: input.build.pluginRecord.name,
      pluginVersion: input.build.pluginRecord.version,
      imageDigest: input.image.imageDigest,
      imageSource: input.image.imageSource,
      ...values,
    })
    .onConflictDoUpdate({ target: [T.orgId, T.pluginName, T.pluginVersion, T.imageDigest], set: values })
    .returning({ id: T.id }));
  const id = (row as { id: string }).id;
  // A refused image deliberately LEFT in the registry, signed, is the one
  // exception to the discard — so keeping it is on the trail: which image,
  // why it was refused, and when it lapses.
  recordAudit({
    action: 'plugin.setup_image.kept',
    actorId: input.build.userId || SYSTEM_ACTOR_ID,
    orgId: input.orgId,
    targetType: 'plugin-kept-setup-image',
    targetId: id,
    details: {
      pluginName: input.build.pluginRecord.name,
      pluginVersion: input.build.pluginRecord.version,
      digest: input.image.imageDigest,
      refusalCode: input.refusal.code,
      findings: findings.length,
      expiresAt: values.expiresAt.toISOString(),
    },
  });
  return id;
}

/** A kept image as the console lists it (without the stored build record). */
export interface KeptSetupImageView {
  id: string;
  pluginName: string;
  pluginVersion: string;
  imageDigest: string;
  imageSource: string;
  refusalCode: string;
  refusalMessage: string;
  refusalFindings: unknown[];
  visibility: string | null;
  publishRequest: boolean;
  keptBy: string;
  keptAt: string;
  expiresAt: string;
}

function view(row: PluginKeptSetupImage): KeptSetupImageView {
  const build = row.build as unknown as Partial<KeptBuild>;
  return {
    id: row.id,
    pluginName: row.pluginName,
    pluginVersion: row.pluginVersion,
    imageDigest: row.imageDigest,
    imageSource: row.imageSource,
    refusalCode: row.refusalCode,
    refusalMessage: row.refusalMessage,
    refusalFindings: row.refusalFindings,
    visibility: build.pluginRecord?.visibility ?? null,
    publishRequest: build.publish !== undefined,
    keptBy: row.keptBy,
    keptAt: row.keptAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** The org's kept setup images, oldest first. */
export async function listKeptSetupImages(orgId: string): Promise<KeptSetupImageView[]> {
  const T = schema.pluginKeptSetupImage;
  const rows = await withTenantTx((tx) => tx.select().from(T).where(eq(T.orgId, orgId)).orderBy(asc(T.keptAt)));
  return (rows as PluginKeptSetupImage[]).map(view);
}

const registryInfo = (): RegistryInfo => Config.get('registry') as RegistryInfo;

/**
 * Discard one kept image and drop its row — unless a stored version references
 * the digest (an identical rebuild that later passed), in which case only the
 * row goes. Never throws; the outcome is counted.
 */
async function discardKept(row: PluginKeptSetupImage, reason: 'expired' | 'superseded'): Promise<void> {
  const T = schema.pluginKeptSetupImage;
  const p = schema.plugin;
  try {
    const inUse = await withTenantTx((tx) => tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.orgId, row.orgId), eq(p.name, row.pluginName), eq(p.imageDigest, row.imageDigest)))
      .limit(1));
    if (inUse.length === 0) {
      const registry = registryInfo();
      await discardPluginImage({
        repository: imageRepository(row.pluginName, registry, row.orgId),
        digest: row.imageDigest,
        registry,
        orgId: row.orgId,
        context: { scope: 'kept-setup-image', reason, keptSetupImageId: row.id, refusalCode: row.refusalCode, pluginVersion: row.pluginVersion },
      });
    }
    await withTenantTx((tx) => tx.delete(T).where(eq(T.id, row.id)));
    // The row is what made the image promotable; dropping it ends that for good.
    recordAudit({
      action: 'plugin.setup_image.discarded',
      actorId: SYSTEM_ACTOR_ID,
      orgId: row.orgId,
      targetType: 'plugin-kept-setup-image',
      targetId: row.id,
      details: { pluginName: row.pluginName, pluginVersion: row.pluginVersion, digest: row.imageDigest, reason, refusalCode: row.refusalCode, imageDiscarded: inUse.length === 0 },
    });
    incCounter('plugin_kept_setup_image_sweep_total', { reason, outcome: inUse.length === 0 ? 'discarded' : 'kept_in_use' });
    logger.info('Kept setup image dropped', { id: row.id, plugin: row.pluginName, version: row.pluginVersion, digest: row.imageDigest, reason, imageDiscarded: inUse.length === 0 });
  } catch (err) {
    incCounter('plugin_kept_setup_image_sweep_total', { reason, outcome: 'failed' });
    logger.error('Could not drop a kept setup image; retried on the next sweep', { id: row.id, plugin: row.pluginName, digest: row.imageDigest, reason, error: errorMessage(err) });
  }
}

/**
 * A version of `name@version` was just stored from `digest`: every kept image of
 * that name+version under ANOTHER digest can never be promoted (the version
 * exists) — discard it. Best-effort; never throws.
 */
export async function supersedeKeptSetupImages(orgId: string, name: string, version: string, digest: string): Promise<void> {
  if (!isSystemOrgId(orgId)) return; // only the system org keeps setup images
  try {
    const T = schema.pluginKeptSetupImage;
    const rows = await withTenantTx((tx) => tx.select().from(T)
      .where(and(eq(T.orgId, orgId), eq(T.pluginName, name), eq(T.pluginVersion, version), ne(T.imageDigest, digest))));
    for (const row of rows as PluginKeptSetupImage[]) await discardKept(row, 'superseded');
  } catch (err) {
    logger.warn('Superseded kept setup images unreadable; the TTL sweep collects them', { name, version, error: errorMessage(err) });
  }
}

/**
 * Discard every kept image past its expiry, then publish how many remain
 * (`plugin_kept_setup_images`). Runs on the rescan scheduler's leader-locked
 * tick, elevated. Never throws.
 */
export async function sweepKeptSetupImages(now = new Date()): Promise<{ discarded: number; remaining: number }> {
  const T = schema.pluginKeptSetupImage;
  try {
    return await runWithTenantContext({ isSuperAdmin: true }, async () => {
      const expired = await withTenantTx((tx) => tx.select().from(T).where(lte(T.expiresAt, now)).orderBy(asc(T.expiresAt)).limit(500)) as PluginKeptSetupImage[];
      for (const row of expired) await discardKept(row, 'expired');
      const [left] = await withTenantTx((tx) => tx.select({ n: count() }).from(T)) as Array<{ n: number }>;
      const remaining = Number(left?.n ?? 0);
      setGauge('plugin_kept_setup_images', {}, remaining);
      return { discarded: expired.length, remaining };
    });
  } catch (err) {
    logger.error('Kept setup image sweep failed', { error: errorMessage(err) });
    return { discarded: 0, remaining: -1 };
  }
}

/** What a promotion stored. */
export interface PromotionResult {
  plugin: { id: string; name: string; version: string; imageDigest: string | null };
  messages: Array<{ level: 'INFO' | 'WARN'; message: string; data?: Record<string, unknown> }>;
}

/**
 * Promote one kept setup image to a version (system org; see the module note).
 * 404 unknown id; 409 `CONFLICT` when the version already exists; 409 with the
 * refusal's code and findings when the CURRENT gates still refuse it (the row
 * stays, its refusal refreshed); 503 when the DB is stale or the image can't be
 * scanned (the row stays).
 */
export async function promoteKeptSetupImage(id: string, actor: { orgId: string; userId: string }): Promise<PromotionResult> {
  const T = schema.pluginKeptSetupImage;
  const [row] = await withTenantTx((tx) => tx.select().from(T).where(and(eq(T.id, id), eq(T.orgId, actor.orgId))).limit(1)) as PluginKeptSetupImage[];
  if (!row) throw new AppError(404, ErrorCode.NOT_FOUND, 'Kept setup image not found');
  const build = row.build as unknown as KeptBuild;
  const subject = { pluginName: row.pluginName, pluginVersion: row.pluginVersion, imageDigest: row.imageDigest, keptSetupImageId: row.id };

  const p = schema.plugin;
  const existing = await withTenantTx((tx) => tx.select({ id: p.id }).from(p)
    .where(and(eq(p.orgId, row.orgId), eq(p.name, row.pluginName), eq(p.version, row.pluginVersion))).limit(1));
  if (existing.length > 0) {
    throw new AppError(409, ErrorCode.CONFLICT, `${row.pluginName}@${row.pluginVersion} already exists; a kept image of it cannot be promoted. It is discarded when it expires.`);
  }

  // The verdict is only as current as the vulnerability DB behind it.
  try {
    await assertVulnDbFresh();
  } catch (err) {
    if (err instanceof VulnDbStaleError) throw new AppError(503, ErrorCode.SERVICE_UNAVAILABLE, `Cannot promote on a stale vulnerability DB: ${err.message}`);
    throw err;
  }

  const registry = registryInfo();
  const ref = { orgId: row.orgId, name: row.pluginName, imageDigest: row.imageDigest };
  try {
    await verifyImageSignature(ref, registry);
  } catch (err) {
    if (err instanceof ImageVerificationError) throw new AppError(409, ErrorCode.IMAGE_VERIFICATION_FAILED, err.message);
    throw err;
  }
  const facts = await establishImageFacts(ref, registry, build.pluginRecord.dockerfile ?? null, 'promote');
  if (!facts.scannedAt || !facts.scan) {
    throw new AppError(503, ErrorCode.IMAGE_SCAN_UNAVAILABLE, `${row.pluginName}@${row.pluginVersion}: the image could not be scanned (its signed SBOM is unreadable or the scanner failed); try again.`);
  }

  const messages: PromotionResult['messages'] = [];
  const emit: GateEmit = (level, message, data) => { messages.push({ level, message, ...(data ? { data } : {}) }); };
  const floor = vulnFloor({ orgId: row.orgId, userId: actor.userId, pluginRecord: build.pluginRecord, imageDigest: row.imageDigest, facts: { ...facts, scan: facts.scan }, trigger: 'promote', emit });
  const refusal = floor.refusal ?? await complianceRefusal(row.orgId, build.pluginRecord, row.imageDigest, facts);
  if (refusal) {
    const findings = refusalFindings(refusal);
    await withTenantTx((tx) => tx.update(T)
      .set({ refusalCode: refusal.code, refusalMessage: refusal.message, refusalFindings: findings })
      .where(eq(T.id, row.id)));
    recordAudit({
      action: 'plugin.setup_image.promote_refused',
      actorId: actor.userId,
      orgId: row.orgId,
      targetType: 'plugin',
      targetId: row.imageDigest,
      details: { ...subject, errorCode: refusal.code, findings: findings.map((f) => (f as { id?: unknown }).id).filter(Boolean) },
    });
    incCounter('plugin_kept_setup_image_promotions_total', { outcome: 'refused' });
    throw new AppError(409, refusal.code, `Still refused: ${refusal.message}`, { ...(refusal.details ?? {}), keptSetupImageId: row.id });
  }

  const plugin = await persistVersion({
    orgId: row.orgId,
    userId: build.userId,
    access: build.access,
    pluginRecord: build.pluginRecord,
    image: { imageDigest: row.imageDigest, imageSource: row.imageSource as BuildResult['imageSource'] },
    facts,
    summary: floor.summary,
    skippedScan: false,
    ...(build.publish ? { publish: build.publish } : {}),
    emit,
  });
  await withTenantTx((tx) => tx.delete(T).where(eq(T.id, row.id)));
  recordAudit({
    action: 'plugin.setup_image.promoted',
    actorId: actor.userId,
    orgId: row.orgId,
    targetType: 'plugin',
    targetId: plugin.id,
    details: {
      ...subject,
      keptBy: row.keptBy || SYSTEM_ACTOR_ID,
      refusedFor: row.refusalCode,
      vulnCritical: facts.vulnCritical,
      vulnCriticalFixable: facts.vulnCriticalFixable,
      waived: floor.summary.waived.length,
      vulnDbBuiltAt: facts.scan.dbBuiltAt?.toISOString() ?? null,
    },
  });
  incCounter('plugin_kept_setup_image_promotions_total', { outcome: 'promoted' });
  return { plugin: { id: plugin.id, name: plugin.name, version: plugin.version, imageDigest: plugin.imageDigest ?? null }, messages };
}
