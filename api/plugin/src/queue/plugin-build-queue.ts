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

import { envInt, createLogger, errorMessage, getServiceAuthHeader, VALID_TIERS, recordAudit } from '@pipeline-builder/api-core';
import type { AppError, QuotaService, QuotaTier } from '@pipeline-builder/api-core';
import { incCounter, observe, withSpan } from '@pipeline-builder/api-server';
import type { SSEManager } from '@pipeline-builder/api-server';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import type { Job, ConnectionOptions } from 'bullmq';

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
} from './connections.js';
import { createBuildFailedHandler } from './failure-handler.js';
import { startDlqWorker, closeDlqWorker } from './plugin-build-dlq.js';
import { startQueueMetricsScraper, stopQueueMetricsScraper } from './queue-metrics-scraper.js';
import { ORG_SLOT_DELAY_MS, tryAcquireOrgSlot, releaseOrgSlot, scrubOrgSlots } from './slot-manager.js';
import { getBuildStrategy } from '../helpers/build-strategy.js';
import { getBuildkitAddrForTier, BUILD_TEMP_ROOT } from '../helpers/docker-build.js';
import type { BuildResult } from '../helpers/docker-build.js';
import { assertPostBuildCompliance, establishImageFacts, type ImageFacts } from '../helpers/image-facts.js';
import { toPluginInsert, type PluginBuildJobData } from '../helpers/plugin-helpers.js';
import { allowUnscanned, scanUnavailableError, vulnGateError } from '../helpers/scan-gates.js';
import { pluginService } from '../services/plugin-service.js';

const logger = createLogger('plugin-build-queue');

/**
 * A scan-gate refusal as a BullMQ {@link UnrecoverableError}: the verdict is
 * deterministic for this image, so BullMQ must not spend another attempt
 * rebuilding it. The typed code / details ride along for the failure handler
 * (build stream, audit, N30).
 */
function terminal(err: AppError): UnrecoverableError {
  return Object.assign(new UnrecoverableError(err.message), { code: err.code, statusCode: err.statusCode, details: err.details });
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
    enterprise: envInt('PLUGIN_BUILD_CONCURRENCY_ENTERPRISE', concurrency, { min: 1 }),
    unlimited: envInt('PLUGIN_BUILD_CONCURRENCY_UNLIMITED', concurrency, { min: 1 }),
  };

  const processor = async (job: Job<PluginBuildJobData>, token?: string) => {
    const { requestId, orgId, userId, access, buildRequest, pluginRecord } = job.data;

    // Custom span around the whole build: BullMQ jobs run out-of-band from any
    // inbound HTTP span, so without this a slow/hung build shows no trace detail.
    return withSpan('plugin.build', () => runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {
      // Qualify the owner-hash key by queue name: BullMQ job ids are
      // per-queue-monotonic, so the four per-tier queues mint colliding ids
      // and a bare id would let one tier's job overwrite another's owner
      // record (wrong-org decrement / leaked slots). scrubOrgSlots builds its
      // live set with the same `${queueName}:${jobId}` shape.
      const slotJobId = `${job.queueName}:${job.id ?? job.name}`;
      if (!await tryAcquireOrgSlot(orgId, slotJobId)) {
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
      try {
        if (job.timestamp) {
          observe('plugin_job_wait_seconds', {}, (Date.now() - job.timestamp) / 1000);
        }

        // Ensure/refresh the build-log stream's owner binding (a backstop) so a
        // cross-tenant ticket mint for this requestId is refused — covers a retry/
        // replay whose original route-time binding TTL lapsed, and any producer
        // that didn't bind at enqueue. Best-effort: a Redis hiccup here must not
        // fail the build (ticket minting simply falls back to caller-org binding).
        await sseManager.bindStreamOwner(requestId, orgId).catch((err) =>
          logger.debug('Stream-owner bind failed (non-fatal)', { requestId, error: errorMessage(err) }));

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
        //  - more fixable Criticals than PLUGIN_VULN_MAX_CRITICAL: PLUGIN_VULN_GATE.
        let facts: ImageFacts | null = null;
        let skippedScan = false;
        if (image) {
          const ref = { orgId, name: pluginRecord.name, imageDigest: image.imageDigest };
          facts = await establishImageFacts(ref, buildRequest.registry, pluginRecord.dockerfile);
          if (!facts.scannedAt) {
            if (!allowUnscanned()) {
              const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
              if (lastAttempt) throw terminal(scanUnavailableError());
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
            });
            const gate = vulnGateError(facts);
            if (gate) throw terminal(gate);
          }
          await assertPostBuildCompliance(orgId, pluginRecord, image.imageDigest, facts);
        }

        const result = await pluginService.deployVersion(
          toPluginInsert(pluginRecord, {
            imageDigest: image?.imageDigest ?? null,
            imageSource: image?.imageSource ?? null,
            ...(facts ? {
              vulnCritical: facts.vulnCritical,
              vulnHigh: facts.vulnHigh,
              vulnMedium: facts.vulnMedium,
              vulnLow: facts.vulnLow,
              vulnCriticalFixable: facts.vulnCriticalFixable,
              vulnHighFixable: facts.vulnHighFixable,
              scannedAt: facts.scannedAt,
              runAsRoot: facts.runAsRoot,
            } : {}),
          }),
          userId,
          access,
        );

        recordBuildEvent(orgId, 'completed', job, {
          pluginName: result.name,
          pluginVersion: result.version,
          pluginId: result.id,
        });

        // job.finishedOn isn't set until the processor returns, so it's always
        // undefined here — use Date.now(), matching recordBuildEvent's fallback.
        const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
        logger.info('Plugin build event', {
          eventCategory: 'plugin-build',
          action: 'plugin.build.completed',
          event: 'completed',
          actorId: userId ?? 'system',
          orgId,
          targetType: 'plugin',
          targetId: result.id,
          pluginName: result.name,
          pluginVersion: result.version,
          jobId: job.id,
          durationMs,
        });

        recordAudit({
          action: 'plugin.build.completed',
          actorId: userId ?? 'system',
          orgId,
          targetType: 'plugin',
          targetId: result.id,
          details: {
            pluginName: result.name,
            pluginVersion: result.version,
            jobId: job.id,
            durationMs,
            ...(image && { imageDigest: image.imageDigest, imageSource: image.imageSource }),
            ...(facts && {
              scanned: facts.scannedAt !== null,
              vulnCritical: facts.vulnCritical,
              vulnHigh: facts.vulnHigh,
              vulnCriticalFixable: facts.vulnCriticalFixable,
              vulnHighFixable: facts.vulnHighFixable,
              runAsRoot: facts.runAsRoot,
            }),
          },
        });

        // The operator escape hatch persisted an UNSCANNED version: that is a
        // security-relevant exception, so it carries its own audit event.
        if (skippedScan && image) {
          recordAudit({
            action: 'plugin.scan.skipped',
            actorId: userId ?? 'system',
            orgId,
            targetType: 'plugin',
            targetId: result.id,
            details: { pluginName: result.name, pluginVersion: result.version, imageDigest: image.imageDigest, reason: 'PLUGIN_ALLOW_UNSCANNED' },
          });
        }

        // Plugin ecosystem: the upload asked for a publish request —
        // submit it now that the version (and its signed digest) exists. Never
        // fails the build: the refusal is reported on the build stream.
        if (job.data.publish) {
          const { submitAfterBuild } = await import('../services/ecosystem/requests.js');
          const outcome = await submitAfterBuild(job.data.publish.caller, result.id);
          sseManager.send(requestId, outcome.ok ? 'INFO' : 'WARN', `Publish request: ${outcome.message}`, {
            ...(outcome.requestId ? { publishRequestId: outcome.requestId, status: outcome.status } : {}),
          });
        }

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
  // Reconcile any slot leaked across the previous process lifetime on boot,
  // and then again on every periodic temp-cleanup tick. Fire-and-forget —
  // errors are logged inside scrubOrgSlots; we don't block startup on it.
  void scrubOrgSlots();
  startQueueMetricsScraper([
    ...getAllTierQueues().map(({ queue }) => ({ name: queue.name, queue })),
    { name: DLQ_NAME, queue: getDeadLetterQueue() },
  ]);
}

// ---------------------------------------------------------------------------
// Periodic temp directory cleanup + slot scrub
// ---------------------------------------------------------------------------

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

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

  // Piggy-back on the cleanup tick to scrub leaked org slots; both walk
  // the live BullMQ state so co-locating amortises the queue reads.
  // Fire-and-forget — errors are logged inside scrubOrgSlots.
  void scrubOrgSlots();

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
  stopQueueMetricsScraper();
  await closeDlqWorker();
  await Promise.all(Array.from(tierWorkers.values()).map((w) => w.close()));
  tierWorkers.clear();
  await closeQueuesAndConnections();
  logger.info('Plugin build queue shut down');
}
