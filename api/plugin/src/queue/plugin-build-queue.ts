// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin build WORKERS: one BullMQ worker per quota tier running the build
 * processor, plus the DLQ worker, the periodic temp-dir sweep and graceful
 * shutdown. Queue handles and Redis connections live in `connections.ts`; the
 * `failed` handler in `failure-handler.ts`; operator re-enqueue in `requeue.ts`.
 */

import * as fs from 'fs';
import path from 'path';

import { SYSTEM_ACTOR_ID, ErrorCode, envInt, createLogger, errorMessage, getServiceAuthHeader, VALID_TIERS, recordAudit } from '@pipeline-builder/api-core';
import type { AppError, PluginScanSummary, QuotaService, QuotaTier } from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge, withSpan } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';
import { and, eq } from 'drizzle-orm';

import { recordBuildEvent } from './build-failures.js';
import { cleanupBuildArtifacts, ensureLocalBuildContext } from './build-workspace.js';
import {
  closeQueuesAndConnections,
  DLQ_NAME,
  getAllTierQueues,
  getBuildCfg,
  getConnectionForTier,
  getDeadLetterQueue,
  getOrgTier,
  getTierQueue,
  isTierConnectionReady,
  tierForQueueName,
} from './connections.js';
import { createBuildFailedHandler } from './failure-handler.js';
import { startDlqWorker, closeDlqWorker } from './plugin-build-dlq.js';
import { startQueueMetricsScraper, stopQueueMetricsScraper } from './queue-metrics-scraper.js';
import {
  MAX_BUILDS_PER_ORG, MAX_SLOT_DELAYS, ORG_SLOT_DELAY_MS, ORG_SLOT_SCRUB_MS,
  tryAcquireOrgSlot, releaseOrgSlot, scrubOrgSlots, startOrgSlotHeartbeat,
} from './slot-manager.js';
import { getBuildStrategy } from '../helpers/build-strategy.js';
import { getBuildkitAddrForTier, BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import type { BuildResult } from '../helpers/docker-build.js';
import { establishImageFacts, type ImageFacts } from '../helpers/image-facts.js';
import { complianceRefusal, vulnFloor } from '../helpers/image-gates.js';
import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { imageRepository, type RegistryInfo } from '../helpers/registry-auth.js';
import { allowUnscanned, scanUnavailableError } from '../helpers/scan-gates.js';
import { discardPluginImage, type DiscardContext } from '../helpers/supply-chain.js';
import { vulnDbMaxAgeMs } from '../helpers/vuln-scan.js';
import { honoursSetupLoad, keepSetupImage, keptSetupImageTtlDays, type KeptBuild } from '../services/kept-setup-images.js';
import { persistVersion } from '../services/version-persist.js';

const logger = createLogger('plugin-build-queue');

/**
 * A scan-gate refusal as a BullMQ {@link UnrecoverableError}: the verdict is
 * deterministic for this image, so BullMQ must not spend another attempt
 * rebuilding it. The typed code / details ride along for the failure handler
 * (build stream, audit, N30), with what became of the refused image.
 */
function terminal(err: AppError, refusedImage: RefusedImageOutcome, image?: { imageDigest: string; keptSetupImageId?: string }): UnrecoverableError {
  // The digest (and a kept image's row id) ride the error so the terminal
  // `plugin.build.failed` audit names WHICH image was refused and where it went.
  return Object.assign(new UnrecoverableError(err.message), {
    code: err.code,
    statusCode: err.statusCode,
    details: { ...err.details, refusedImage, ...(image && { imageDigest: image.imageDigest }), ...(image?.keptSetupImageId && { keptSetupImageId: image.keptSetupImageId }) },
  });
}

/** What became of a refused build's image (`plugin_refused_image_discards_total{outcome}`). */
type RefusedImageOutcome = 'discarded' | 'kept_in_use' | 'kept_setup_load' | 'failed';

/**
 * Remove the pushed, signed image of a build the gates REFUSED — best-effort,
 * and never allowed to replace the refusal the caller is about to throw.
 *
 * The image was pushed and signed before the gates could run (they read the
 * signed SBOM). Left in place it is a manifest in the org's namespace carrying
 * a valid platform signature: pullable by digest and verifiable, so the only
 * thing marking it as refused would be the absence of a catalog row.
 *
 * NOT when any version row of this plugin already references the digest. A
 * rebuild of identical content (a prebuilt tarball re-uploaded, a reproducible
 * build) pushes the same digest as a version that passed earlier; deleting it
 * would break every pipeline pinned to that version. Soft-deleted rows count
 * too — they can be restored. Neither condition can be confirmed → keep it.
 *
 * Outcomes on `plugin_refused_image_discards_total{outcome}`: discarded,
 * kept_in_use, failed — and kept_setup_load, see {@link keepRefusedSetupImage}.
 */
async function discardRefusedImage(orgId: string, name: string, digest: string, registry: RegistryInfo, reason: string, context: Omit<DiscardContext, 'refusalCode'> = {}): Promise<RefusedImageOutcome> {
  try {
    const p = schema.plugin;
    const inUse = await withTenantTx((tx) => tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.orgId, orgId), eq(p.name, name), eq(p.imageDigest, digest)))
      .limit(1));
    if (inUse.length > 0) {
      incCounter('plugin_refused_image_discards_total', { outcome: 'kept_in_use' });
      logger.info('Refused image kept: a stored version references the same digest', { orgId, name, digest, reason });
      return 'kept_in_use';
    }
    const { deleted } = await discardPluginImage({ repository: imageRepository(name, registry, orgId), digest, registry, orgId, context: { refusalCode: reason, ...context } });
    incCounter('plugin_refused_image_discards_total', { outcome: 'discarded' });
    logger.info('Refused image removed from the registry', { orgId, name, digest, reason, manifestsDeleted: deleted });
    return 'discarded';
  } catch (err) {
    incCounter('plugin_refused_image_discards_total', { outcome: 'failed' });
    logger.error('Could not remove a refused image; it stays in the registry, signed', { orgId, name, digest, reason, error: errorMessage(err) });
    return 'failed';
  }
}

/**
 * The ONE exception to {@link discardRefusedImage}: a refused image from the
 * SETUP catalog load (a system-org upload marked `setupLoad`) is KEPT, signed,
 * and recorded for promotion without a rebuild (services/kept-setup-images.ts).
 * Nothing is stored as a version — the refusal stands. When the record can't be
 * written the image is discarded after all: a kept image nobody can find or
 * expire is exactly the signed orphan the discard exists to prevent.
 */
async function keepRefusedSetupImage(
  orgId: string,
  image: { imageDigest: string; imageSource: BuildResult['imageSource'] },
  refusal: AppError,
  build: KeptBuild,
  registry: RegistryInfo,
): Promise<{ outcome: RefusedImageOutcome; keptSetupImageId?: string }> {
  try {
    const keptSetupImageId = await keepSetupImage({ orgId, image, refusal, build });
    incCounter('plugin_refused_image_discards_total', { outcome: 'kept_setup_load' });
    logger.warn('Refused SETUP-load image kept for promotion', { orgId, name: build.pluginRecord.name, digest: image.imageDigest, reason: refusal.code, keptSetupImageId });
    return { outcome: 'kept_setup_load', keptSetupImageId };
  } catch (err) {
    logger.error('Could not record a kept setup image; discarding it instead', { orgId, name: build.pluginRecord.name, digest: image.imageDigest, error: errorMessage(err) });
    return { outcome: await discardRefusedImage(orgId, build.pluginRecord.name, image.imageDigest, registry, refusal.code, { pluginVersion: build.pluginRecord.version, userId: build.userId }) };
  }
}

const tierWorkers = new Map<QuotaTier, Worker<PluginBuildJobData>>();

function isWorkerReady(): boolean {
  return VALID_TIERS.every((tier) => tierWorkers.has(tier) && isTierConnectionReady(tier));
}

/**
 * Wait for every tier worker's Redis connection to become ready. Each tier
 * is awaited concurrently against a shared timeout budget; rejects with the
 * first unmet tier (or a combined timeout) so a stuck Redis on one tier
 * fails fast instead of hanging behind a single-tier check.
 */
export function waitForWorkerReady(timeoutMs = getBuildCfg().workerTimeoutMs): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isWorkerReady()) return resolve();

    const waiters = VALID_TIERS.map((tier) => new Promise<void>((res, rej) => {
      const worker = tierWorkers.get(tier);
      if (!worker) return rej(new Error(`Worker for tier ${tier} not started`));
      if (isTierConnectionReady(tier)) return res();
      // One NAMED listener so the timeout removes the exact one it registered (the
      // previous code off()'d a function it never added, leaking the listener and
      // letting a late 'ready' res() after rej()).
      const onReady = () => { clearTimeout(timer); res(); };
      const timer = setTimeout(() => {
        worker.off('ready', onReady);
        rej(new Error(`Worker for tier ${tier} not ready after ${timeoutMs}ms`));
      }, timeoutMs);
      worker.on('ready', onReady);
    }));

    Promise.all(waiters).then(() => resolve(), (err) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

export function startWorker(sseManager: SSEManager, quotaService: QuotaService): void {
  if (tierWorkers.size > 0) return;

  const { concurrency } = getBuildCfg();
  const tierConcurrency: Record<QuotaTier, number> = {
    developer: envInt('PLUGIN_BUILD_CONCURRENCY_DEVELOPER', concurrency, { min: 1 }),
    pro: envInt('PLUGIN_BUILD_CONCURRENCY_PRO', concurrency, { min: 1 }),
    team: envInt('PLUGIN_BUILD_CONCURRENCY_TEAM', concurrency, { min: 1 }),
    business: envInt('PLUGIN_BUILD_CONCURRENCY_BUSINESS', concurrency, { min: 1 }),
    enterprise: envInt('PLUGIN_BUILD_CONCURRENCY_ENTERPRISE', concurrency, { min: 1 }),
    unlimited: envInt('PLUGIN_BUILD_CONCURRENCY_UNLIMITED', concurrency, { min: 1 }),
  };

  const processor = async (job: Job<PluginBuildJobData>, token?: string) => {
    const { requestId, orgId, userId, access, buildRequest, pluginRecord } = job.data;
    // The setup catalog load's marker keeps a gate-refused image for promotion
    // (keepRefusedSetupImage) — for the SYSTEM org only. Anyone else's marker is
    // ignored: their refused image is discarded like every other.
    const setupLoad = honoursSetupLoad(orgId, job.data.setupLoad);
    if (job.data.setupLoad && !setupLoad) {
      logger.warn('setupLoad ignored: honoured for system-org builds only', { orgId, plugin: pluginRecord.name, version: pluginRecord.version });
    }

    // Custom span around the whole build: BullMQ jobs run out-of-band from any
    // inbound HTTP span, so without this a slow/hung build shows no trace detail.
    return withSpan('plugin.build', () => runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {
      // Qualify the owner-hash key by queue name: BullMQ job ids are
      // per-queue-monotonic, so the four per-tier queues mint colliding ids
      // and a bare id would let one tier's job overwrite another's owner
      // record (wrong-org decrement / leaked slots). scrubOrgSlots builds its
      // live set with the same `${queueName}:${jobId}` shape.
      const slotJobId = `${job.queueName}:${job.id ?? job.name}`;
      const tier = tierForQueueName(job.queueName);

      // Ensure/refresh the build-log stream's owner binding (a backstop) so a
      // cross-tenant ticket mint for this requestId is refused — covers a retry/
      // replay whose original route-time binding TTL lapsed, and any producer
      // that didn't bind at enqueue. Best-effort: a Redis hiccup here must not
      // fail the build (ticket minting simply falls back to caller-org binding).
      //
      // Bound BEFORE the slot gate, not after, so a build that has to WAIT for a
      // slot can say so on its own stream. Nothing was emitted on that path
      // before, because it returned above the first `send` — the build simply sat
      // in "queued" with no reason given. Binding earlier is strictly more
      // conservative: the cross-tenant refusal is in place for longer, not less.
      await sseManager.bindStreamOwner(requestId, orgId).catch((err) =>
        logger.debug('Stream-owner bind failed (non-fatal)', { requestId, error: errorMessage(err) }));

      if (!await tryAcquireOrgSlot(orgId, slotJobId)) {
        const slotDelays = (job.data.slotDelays ?? 0) + 1;
        const waitedMs = slotDelays * ORG_SLOT_DELAY_MS;
        incCounter('plugin_build_slot_denied_total', { tier });

        // Past the budget the build fails TERMINALLY with a reason. A slot delay
        // spends no BullMQ attempt (that is the point of the DelayedError pairing
        // below), so this budget is the only thing between a starved job and an
        // endless silent bounce. `UnrecoverableError` keeps BullMQ from retrying
        // a verdict that will not change while the org stays at its cap; the
        // typed code and details ride along for the failure handler, which is
        // what puts the refusal on the build stream and in the audit.
        if (slotDelays > MAX_SLOT_DELAYS) {
          incCounter('plugin_build_slot_timeout_total', { tier });
          throw Object.assign(
            new UnrecoverableError(
              `No build slot after ${Math.round(waitedMs / 1000)}s: this organization is at its limit of ${MAX_BUILDS_PER_ORG} concurrent builds. Wait for one to finish and submit again.`,
            ),
            { code: ErrorCode.SERVICE_UNAVAILABLE, statusCode: 503, details: { slotDelays, waitedMs, maxBuildsPerOrg: MAX_BUILDS_PER_ORG } },
          );
        }

        // Once, on the FIRST delay. The gate is re-evaluated every
        // ORG_SLOT_DELAY_MS, so emitting per delay would put a message on the
        // stream every ten seconds for as long as the wait lasts.
        if (slotDelays === 1) {
          sseManager.send(requestId, 'WARN',
            `Waiting for a build slot: this organization is at its limit of ${MAX_BUILDS_PER_ORG} concurrent builds. The build starts automatically when a slot frees up — there is nothing to buy or fix.`,
            { maxBuildsPerOrg: MAX_BUILDS_PER_ORG, retryInMs: ORG_SLOT_DELAY_MS });
        }

        // Persist the count BEFORE delaying, so the next pass sees it. Dropping
        // this write would reset the budget on every pass and restore the endless
        // bounce it exists to stop.
        await job.updateData({ ...job.data, slotDelays });
        await job.moveToDelayed(Date.now() + ORG_SLOT_DELAY_MS, token);
        // `DelayedError` is the sentinel that PAIRS with `moveToDelayed`: the
        // worker leaves the job delayed and picks up the next one.
        // `Worker.RateLimitError()` takes a different branch — it calls
        // `moveLimitedBackToWait`, which put the job straight back on the wait
        // list and undid the `moveToDelayed` above. The org's backoff never
        // applied, so a job whose org was at its slot limit span through the
        // worker again and again instead of waiting ORG_SLOT_DELAY_MS.
        throw new DelayedError();
      }

      // The TTL on the slot counter is a crash-recovery window, so a build that
      // outlives it has to keep its own slot alive (see startOrgSlotHeartbeat).
      const stopSlotHeartbeat = startOrgSlotHeartbeat(orgId, slotJobId);
      try {
        if (job.timestamp) {
          // Labelled by tier: unlabelled, this could not answer which tier waits
          // longest, which is the question the per-tier slot numbers are picked
          // from. Includes any time spent delayed for a slot, since it measures
          // from enqueue.
          observe('plugin_job_wait_seconds', { tier }, (Date.now() - job.timestamp) / 1000);
        }

        sseManager.send(requestId, 'INFO', 'Build started', {
          jobId: job.id,
          plugin: `${pluginRecord.name}:${pluginRecord.version}`,
        });

        // Materialize the build context on THIS replica (fast path if the
        // uploader was here; else download+extract the staged ZIP from S3). Only
        // needed when the build produces an image — metadata-only jobs never
        // enqueue, so this is on the image path regardless.
        await ensureLocalBuildContext(buildRequest);

        try { fs.utimesSync(buildRequest.contextDir, new Date(), new Date()); } catch { /* ignore */ }

        const isApprovalStep = pluginRecord.pluginType === 'ManualApprovalStep';
        let fullImage = '';
        // The signed digest + where the image came from, persisted with the row so
        // synth pins CodeBuild to exactly this image. Stays null for approval steps.
        let image: { imageDigest: string; imageSource: BuildResult['imageSource'] } | null = null;

        const strategy = getBuildStrategy(buildRequest.buildType);
        // isApprovalStep is a second, orthogonal "skip build" axis (pluginType), kept here.
        if (!isApprovalStep && strategy.producesImage) {
          const result = await strategy.produceImage(buildRequest, {
            // Lazy: only build_image awaits this, so prebuilt skips the tier/quota lookup.
            getBuildkitAddr: async () => getBuildkitAddrForTier(
              await getOrgTier(quotaService, orgId, getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }))),
            // Stream masked build lines to the owner-bound SSE stream so the user
            // sees live build output. Best-effort — a send failure never fails the
            // build (the sink is already try/guarded inside the process runner).
            onLine: (line, stream) => { sseManager.send(requestId, 'MESSAGE', line, { stream, log: true }); },
          });
          fullImage = result.fullImage;
          image = { imageDigest: result.digest, imageSource: result.imageSource };
          sseManager.send(requestId, 'INFO', 'Image pushed and signed', { fullImage, digest: result.digest });
        }

        // scan the signed image (grype over its signed SBOM), resolve its
        // USER, apply the platform scan gates, then run the compliance rules
        // the upload deferred — signed, scanned, vuln*, runAsRoot, packages —
        // on the REAL facts, before the version is persisted. A block fails the
        // build permanently.
        //  - unscanned: retryable (BullMQ attempts/backoff) until the job's
        //    last attempt, which fails IMAGE_SCAN_UNAVAILABLE — unless the
        //    operator escape hatch PLUGIN_ALLOW_UNSCANNED persists it unscanned;
        //  - more gated findings (fixable, at/above PLUGIN_VULN_FAIL_ON) than PLUGIN_VULN_MAX_FINDINGS: PLUGIN_VULN_GATE.
        //  - a REFUSED image (any terminal gate / compliance verdict) is
        //    removed from the registry again, best-effort — see
        //    discardRefusedImage — or, for the system org's setup catalog
        //    load, kept for promotion (keepRefusedSetupImage).
        let facts: ImageFacts | null = null;
        let skippedScan = false;
        let summary: PluginScanSummary | null = null;
        const emit = (level: 'INFO' | 'WARN', message: string, data?: Record<string, unknown>) => sseManager.send(requestId, level, message, data);
        if (image) {
          const pushed = image;
          const refuse = async (err: AppError): Promise<never> => {
            if (setupLoad) {
              const kept = await keepRefusedSetupImage(orgId, pushed, err, { userId, access, pluginRecord, ...(job.data.publish ? { publish: job.data.publish } : {}) }, buildRequest.registry);
              if (kept.outcome === 'kept_setup_load') {
                sseManager.send(requestId, 'WARN',
                  `Image refused (${err.code}) but KEPT in the registry because this is a setup catalog load: no version was saved. `
                  + `Promote it once fixed or waived (POST /api/plugins/kept-setup-images/${kept.keptSetupImageId}/promote); it is discarded after ${keptSetupImageTtlDays()} days.`,
                  { refusedImage: 'kept_setup_load', keptSetupImageId: kept.keptSetupImageId });
              }
              throw terminal(err, kept.outcome, { imageDigest: pushed.imageDigest, ...(kept.keptSetupImageId && { keptSetupImageId: kept.keptSetupImageId }) });
            }
            throw terminal(err, await discardRefusedImage(orgId, pluginRecord.name, pushed.imageDigest, buildRequest.registry, err.code, {
              pluginVersion: pluginRecord.version,
              ...(job.id && { jobId: job.id }),
              ...(requestId && { requestId }),
              ...(userId && { userId }),
            }), { imageDigest: pushed.imageDigest });
          };
          const ref = { orgId, name: pluginRecord.name, imageDigest: image.imageDigest };
          facts = await establishImageFacts(ref, buildRequest.registry, pluginRecord.dockerfile);

          // Binaries the scanner cannot see into. Never a gate — the CVEs in them
          // are unknown, not known-bad — but a clean result over an image that is
          // mostly an opaque Haskell or packed-Go binary is not the same claim as
          // a clean result over a fully catalogued one, and the build output is
          // where the publisher can still do something about it.
          const opaque = facts.uncataloguedBinaries ?? [];
          if (facts.uncataloguedBinaries) setGauge('plugin_uncatalogued_binaries', { plugin: pluginRecord.name }, opaque.length);
          if (opaque.length > 0) {
            sseManager.send(requestId, 'WARN',
              `${opaque.length} executable(s) are not accounted for by any SBOM package, so the vulnerability scan cannot see inside them: `
              + `${opaque.slice(0, 5).join(', ')}${opaque.length > 5 ? ', …' : ''}`,
              { uncataloguedBinaries: opaque.length });
          }

          if (!facts.scannedAt || !facts.scan) {
            if (!allowUnscanned()) {
              const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
              if (lastAttempt) await refuse(scanUnavailableError());
              throw new Error('Image could not be scanned; retrying the build');
            }
            skippedScan = true;
            sseManager.send(requestId, 'WARN', 'Image could not be scanned — persisted UNSCANNED (PLUGIN_ALLOW_UNSCANNED)', { scanned: false });
          } else {
            sseManager.send(requestId, 'INFO', 'Image scanned', {
              vulnCritical: facts.vulnCritical,
              vulnHigh: facts.vulnHigh,
              vulnCriticalFixable: facts.vulnCriticalFixable,
              vulnHighFixable: facts.vulnHighFixable,
              runAsRoot: facts.runAsRoot,
              dbBuiltAt: facts.scan.dbBuiltAt?.toISOString() ?? null,
            });
            // A build scan is only as current as the DB it matched against. The
            // build does not refuse on an old DB (grype's own five-day limit
            // still does) — blocking every publish because the operator's
            // refresh CronJob stalled would be the wrong blast radius — but it
            // must not present a stale result as a current one.
            const dbAgeMs = facts.scan.dbBuiltAt ? Date.now() - facts.scan.dbBuiltAt.getTime() : null;
            if (dbAgeMs === null || dbAgeMs > vulnDbMaxAgeMs()) {
              sseManager.send(requestId, 'WARN', dbAgeMs === null
                ? 'Vulnerability DB build time unknown — this scan may be matching against an outdated DB'
                : `Vulnerability DB is ${Math.round(dbAgeMs / 3_600_000)}h old (limit PLUGIN_VULN_DB_MAX_AGE_HOURS=${Math.round(vulnDbMaxAgeMs() / 3_600_000)}h) — vulnerabilities published since are not in this scan`,
              { dbBuiltAt: facts.scan.dbBuiltAt?.toISOString() ?? null });
            }
            // The floor (waivers made visible — streamed, counted, audited) and
            // its summary: helpers/image-gates.ts, shared with promotion.
            const floor = vulnFloor({ orgId, userId, pluginRecord, imageDigest: image.imageDigest, facts: { ...facts, scan: facts.scan }, trigger: 'build', emit });
            summary = floor.summary;
            if (floor.refusal) await refuse(floor.refusal);
          }
          // A compliance BLOCK is a verdict; an unreachable compliance service
          // is a plain error the job retries — that image is not refused yet,
          // so it stays.
          const blocked = await complianceRefusal(orgId, pluginRecord, image.imageDigest, facts);
          if (blocked) await refuse(blocked);
        }

        // The success tail — store the version, the skipped-scan record, the
        // publish request — is services/version-persist.ts, shared with the
        // promotion of a kept setup image so the two store the same thing.
        const result = await persistVersion({
          orgId,
          userId,
          access,
          pluginRecord,
          image,
          facts,
          summary,
          skippedScan,
          ...(job.data.publish ? { publish: job.data.publish } : {}),
          emit,
          onStored: (stored) => {
            recordBuildEvent(orgId, 'completed', job, {
              pluginName: stored.name,
              pluginVersion: stored.version,
              pluginId: stored.id,
            });

            // job.finishedOn isn't set until the processor returns, so it's always
            // undefined here — use Date.now(), matching recordBuildEvent's fallback.
            const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
            logger.info('Plugin build event', {
              eventCategory: 'plugin-build',
              action: 'plugin.build.completed',
              event: 'completed',
              actorId: userId ?? SYSTEM_ACTOR_ID,
              orgId,
              targetType: 'plugin',
              targetId: stored.id,
              pluginName: stored.name,
              pluginVersion: stored.version,
              jobId: job.id,
              durationMs,
            });

            recordAudit({
              action: 'plugin.build.completed',
              actorId: userId ?? SYSTEM_ACTOR_ID,
              orgId,
              targetType: 'plugin',
              targetId: stored.id,
              details: {
                pluginName: stored.name,
                pluginVersion: stored.version,
                jobId: job.id,
                // Links the build to its `plugin.upload` row (same request id).
                requestId,
                durationMs,
                ...(image && { imageDigest: image.imageDigest, imageSource: image.imageSource }),
                ...(facts && {
                  scanned: facts.scannedAt !== null,
                  vulnCritical: facts.vulnCritical,
                  vulnHigh: facts.vulnHigh,
                  vulnCriticalFixable: facts.vulnCriticalFixable,
                  vulnHighFixable: facts.vulnHighFixable,
                  runAsRoot: facts.runAsRoot,
                  // What the scan could NOT vouch for, on the durable record: the
                  // DB it matched against (a clean result is only as current as
                  // that) and the binaries it could not see into.
                  vulnDbBuiltAt: facts.scan?.dbBuiltAt?.toISOString() ?? null,
                  kev: summary?.kev ?? 0,
                  uncataloguedBinaries: facts.uncataloguedBinaries?.length ?? null,
                }),
              },
            });
          },
        });

        sseManager.send(requestId, 'COMPLETED', 'Plugin deployed', {
          id: result.id,
          name: result.name,
          version: result.version,
          fullImage,
          digest: image?.imageDigest,
        });

        cleanupBuildArtifacts(buildRequest);

        return { pluginId: result.id, fullImage };
      } finally {
        stopSlotHeartbeat();
        // NEVER let the slot release decide the job's outcome. A rejection here
        // (a Redis blip) replaced the processor's return value, so a build that
        // had already published its image was reported FAILED and retried from
        // scratch. Releasing the slot is bookkeeping; `scrubOrgSlots` reclaims
        // anything this drops.
        await releaseOrgSlot(orgId, slotJobId).catch((err) => {
          logger.warn('Org build slot release failed; leaving it for the scrubber', {
            orgId, slotJobId, error: errorMessage(err),
          });
        });
      }
    }), {
      'pb.org_id': orgId,
      'pb.plugin': `${pluginRecord.name}:${pluginRecord.version}`,
      'pb.job_id': String(job.id ?? job.name),
    });
  };

  // -- Error handling -------------------------------------------------------

  const failedHandler = createBuildFailedHandler(sseManager, quotaService);

  const errorHandler = (error: Error) => {
    logger.error('Worker error', { error: error.message });
  };

  const completedHandler = (job: Job<PluginBuildJobData>) => {
    const orgId = job.data?.orgId ?? 'unknown';
    incCounter('plugin_builds_total', { status: 'success', org_id: orgId });
    if (job.processedOn && job.finishedOn) {
      observe('plugin_build_duration_seconds',
        { org_id: orgId },
        (job.finishedOn - job.processedOn) / 1000,
      );
    }
    logger.info('Plugin build completed', { jobId: job.id, name: job.name });
  };

  for (const tier of VALID_TIERS) {
    const tierQueue = getTierQueue(tier);
    const tierWorker = new Worker<PluginBuildJobData>(tierQueue.name, processor, {
      connection: getConnectionForTier(tier) as ConnectionOptions,
      concurrency: tierConcurrency[tier],
    });

    tierWorker.on('failed', failedHandler);
    tierWorker.on('error', errorHandler);
    tierWorker.on('completed', completedHandler);
    tierWorker.on('ready', () => {
      logger.info('Plugin build worker ready (Redis connected)', { tier, concurrency: tierConcurrency[tier] });
    });

    tierWorkers.set(tier, tierWorker);
  }

  logger.info('Plugin build workers started', { tierConcurrency });

  startDlqWorker(quotaService);
  startTempCleanup();
  // Reconcile any slot leaked across the previous process lifetime on boot, then
  // on ORG_SLOT_SCRUB_MS. Fire-and-forget — errors are logged inside
  // scrubOrgSlots; we don't block startup on it.
  void scrubOrgSlots();
  startSlotScrub();
  startQueueMetricsScraper([
    ...getAllTierQueues().map(({ queue }) => ({ name: queue.name, queue })),
    { name: DLQ_NAME, queue: getDeadLetterQueue() },
  ]);
}

// ---------------------------------------------------------------------------
// Periodic temp directory cleanup + slot scrub
// ---------------------------------------------------------------------------

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let slotScrubTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reconcile leaked org build slots on ORG_SLOT_SCRUB_MS.
 *
 * This used to piggy-back `cleanupStaleTempDirs`, which ticks at
 * `TEMP_DIR_MAX_AGE_MS` — four hours, a max AGE borrowed as a period and
 * sixteen times the slot TTL. The TTL was therefore the de-facto reclaimer and
 * the scrub its backstop, which is the wrong way round now that the TTL is
 * heartbeat-extended and no longer expires under a long build.
 */
function startSlotScrub(): void {
  if (slotScrubTimer) return;
  slotScrubTimer = setInterval(() => { void scrubOrgSlots(); }, ORG_SLOT_SCRUB_MS);
  slotScrubTimer.unref();
}

/**
 * Collect context dirs referenced by jobs across main queue and DLQ.
 * Includes failed state to protect dirs during DLQ backoff.
 */
async function getProtectedContextDirs(): Promise<Set<string>> {
  const dirs = new Set<string>();
  const states = ['waiting', 'delayed', 'active', 'failed'] as const;
  try {
    const tierJobLists = await Promise.all([
      ...getAllTierQueues().map(({ queue }) => queue.getJobs([...states])),
      getDeadLetterQueue().getJobs([...states]),
    ]);
    for (const jobs of tierJobLists) {
      for (const job of jobs) {
        const dir = job.data?.buildRequest?.contextDir;
        if (dir) dirs.add(dir);
      }
    }
  } catch { /* best-effort */ }
  return dirs;
}

function cleanupStaleTempDirs(): void {
  const tmpRoot = BUILD_TEMP_ROOT;
  if (!fs.existsSync(tmpRoot)) return;

  getProtectedContextDirs().then((protectedDirs) => {
    const maxAgeMs = getBuildCfg().tempDirMaxAgeMs;
    try {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(tmpRoot, entry.name);
        if (protectedDirs.has(dirPath)) continue;
        try {
          const stat = fs.statSync(dirPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            logger.debug('Cleaned up stale temp dir', { path: dirPath });
          }
        } catch (err) {
          logger.debug('Failed to clean temp dir', { path: dirPath, error: errorMessage(err) });
        }
      }
    } catch (err) {
      logger.debug('Temp dir cleanup scan failed', { error: errorMessage(err) });
    }
  }).catch(() => {});
}

function startTempCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupStaleTempDirs, getBuildCfg().tempDirMaxAgeMs);
  cleanupTimer.unref();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function shutdownQueue(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (slotScrubTimer) {
    clearInterval(slotScrubTimer);
    slotScrubTimer = null;
  }
  stopQueueMetricsScraper();
  await closeDlqWorker();
  await Promise.all(Array.from(tierWorkers.values()).map((w) => w.close()));
  tierWorkers.clear();
  await closeQueuesAndConnections();
  logger.info('Plugin build queue shut down');
}
