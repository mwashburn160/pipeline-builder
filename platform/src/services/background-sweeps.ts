// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every periodic background sweep platform runs, in one registry.
 *
 * A sweep is a DEFINITION — `{ name, lockKey?, intervalMs, run }` — exported by
 * the module that owns the work; this file decides which ones apply to the
 * deployment, builds them and starts them. With a `lockKey` the sweep runs under
 * the cross-pod leader lock (one replica per window, see utils/leader-lock.ts);
 * without one it runs on every replica. Each is an api-core scheduler: unref'd,
 * start-once, and never overlapping itself on one pod.
 *
 * Started after Mongo connects (the first run is not a guaranteed miss against a
 * cold datastore) and stopped, all together, before it disconnects.
 */

import { createLogger, createScheduler, errorMessage, leaderLockKey, type LeaderLockRun, type Scheduler } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { createLockedSweep } from '../utils/leader-lock.js';

const logger = createLogger('background-sweeps');

/** A sweep built from its body. */
export interface IntervalSweepDefinition {
  name: string;
  /** Cross-pod leader-lock key; omit to run on every replica. */
  lockKey?: string;
  intervalMs: number;
  /** Run once at start (default true). */
  runOnStart?: boolean;
  /**
   * The sweep body. `run.signal` aborts when the lock is lost mid-run or the
   * process is shutting down; a sweep that iterates over units of work should
   * check it between them and return (see org-purge).
   */
  run: (run: LeaderLockRun) => Promise<void>;
  /**
   * TRUE only if running this body on several replicas at once is safe — every
   * unit of work atomically claimed, or the whole thing read-only. It licenses the
   * no-Redis path: without it a locked sweep SKIPS when Redis is unconfigured
   * rather than running everywhere (see utils/leader-lock.ts). Default false,
   * because the expensive mistake is assuming safety that isn't there.
   */
  concurrencySafe?: boolean;
}

/** Build (not start) the scheduler for one definition. */
export function buildSweep(def: IntervalSweepDefinition): Scheduler {
  const { name, lockKey, intervalMs, runOnStart, run, concurrencySafe } = def;
  return lockKey
    ? createLockedSweep({
      name,
      lockKey,
      intervalMs,
      runOnStart,
      run,
      ...(concurrencySafe !== undefined ? { concurrencySafe } : {}),
    })
    : createScheduler({ name, intervalMs, runOnStart, run });
}

/** The sweeps that apply to this deployment. */
export async function sweepDefinitions(): Promise<IntervalSweepDefinition[]> {
  const defs: IntervalSweepDefinition[] = [];

  // Re-append platform-local audit events whose write failed (spooled to Redis
  // by `recordAuditEvent`). Every replica drains — the spool's atomic LMOVE
  // hands each entry to exactly one drainer — so no leader lock. Each tick also
  // heartbeats this pod's spool ownership and reclaims stale owners' in-flight
  // entries (the first run is the boot-time recovery).
  const { drainLocalAuditSpool } = await import('../helpers/audit.js');
  defs.push({
    name: 'audit-local-spool-drain',
    intervalMs: config.audit.spoolDrainIntervalMs,
    run: async () => { await drainLocalAuditSpool(); },
  });

  // Delete audit events past AUDIT_RETENTION_DAYS, watermarking each chain
  // first so verify can tell retention from deletion of the oldest rows.
  const { auditRetentionSweep } = await import('./audit-retention.js');
  defs.push(auditRetentionSweep());

  // Publish each audit chain's signed head to write-once object storage (see
  // services/audit-head-export.ts). One exporter per window.
  const { runAuditHeadExportSweep, headExportTarget } = await import('./audit-head-export.js');
  if (headExportTarget()) {
    defs.push({
      name: 'audit-head-export',
      lockKey: leaderLockKey('platform', 'audit-head-export'),
      // Read-and-publish per chain, and the object store write is write-once —
      // two exporters would write identical heads, not conflicting ones.
      concurrencySafe: true,
      intervalMs: config.audit.headExport.intervalMs,
      // Throws when any chain failed, so SchedulerJobStale sees a failing export.
      run: runAuditHeadExportSweep,
    });
  } else {
    logger.warn('Audit chain-head export DISABLED (AUDIT_HEAD_EXPORT_S3_* unset) — /audit/verify cannot detect tail truncation');
  }

  // Reconcile paid-signup billing bootstraps that failed fail-open (orgs carrying
  // a `pendingBillingPlanId` marker). One replica per window, so the fleet does
  // not provision the same pending orgs in parallel. The boot drain runs
  // separately (see index.ts), so no run on start.
  if (config.billing.enabled && config.billing.reconcileIntervalMs > 0) {
    const { reconcilePendingBillingSubscriptions } = await import('./billing-provision.js');
    defs.push({
      name: 'billing-reconcile',
      lockKey: leaderLockKey('platform', 'billing-reconcile'),
      intervalMs: config.billing.reconcileIntervalMs,
      runOnStart: false,
      run: async () => { await reconcilePendingBillingSubscriptions(); },
    });
  }

  // Re-verify domain-based-join domains: re-check the DNS TXT proof for domains
  // not verified recently and un-verify any whose record is definitively gone,
  // so a stale domain can't keep admitting signups forever.
  const { domainReverifyIntervalMs, domainReverifyStaleMs } = config.organization;
  if (domainReverifyIntervalMs > 0) {
    defs.push({
      name: 'domain-reverify',
      lockKey: leaderLockKey('platform', 'domain-reverify'),
      // DNS re-checks are reads; the un-verify write is idempotent (same domain,
      // same outcome), so N replicas converge rather than conflict.
      concurrencySafe: true,
      intervalMs: domainReverifyIntervalMs,
      runOnStart: false,
      run: async () => {
        const { orgDomainService } = await import('./org-domain-service.js');
        const res = await orgDomainService.reverifyStaleDomains(domainReverifyStaleMs);
        if (res.checked > 0) logger.info('Domain re-verification sweep', res);
      },
    });
  }

  // The durable cascade outbox: delivers every downstream leg of an org purge or
  // a user erasure (pipeline, plugin, compliance, message, reporting, quota,
  // billing, the registry) with backoff, dead-lettering into an alert.
  const [{ invitationReaperSweep }, { impersonationReaperSweep }, { orgPurgeSweep }, { cascadeOutboxSweep }] = await Promise.all([
    import('./invitation-reaper.js'),
    import('./impersonation-reaper.js'),
    import('./org-purge.js'),
    import('./cascade-outbox.js'),
  ]);
  defs.push(
    invitationReaperSweep(),
    impersonationReaperSweep(config.impersonation.reaperIntervalMs),
    orgPurgeSweep(),
    cascadeOutboxSweep(),
  );

  // Verify an org's secrets under its new KMS config once every replica's
  // per-org key cache has lapsed (Organization.kmsVerifyDueAt marker).
  const { kmsConfigVerifySweep } = await import('./kms-config-verify.js');
  defs.push(kmsConfigVerifySweep());
  return defs;
}

/**
 * Build and start every applicable sweep. Returns the started schedulers so the
 * caller can stop them on shutdown. A sweep that fails to build is logged and
 * skipped — one broken sweep must not keep the rest (or the service) down.
 */
export async function registerBackgroundSweeps(): Promise<Scheduler[]> {
  const started: Scheduler[] = [];
  for (const def of await sweepDefinitions()) {
    try {
      const sweep = buildSweep(def);
      sweep.start();
      started.push(sweep);
    } catch (err) {
      logger.error('Background sweep failed to start', { name: def.name, error: errorMessage(err) });
    }
  }
  logger.info('Background sweeps started', { sweeps: started.length });
  return started;
}
