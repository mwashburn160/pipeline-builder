// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit retention prune: delete audit events older than `AUDIT_RETENTION_DAYS`,
 * one chain at a time, recording each chain's signed retention WATERMARK first
 * (`helpers/audit-chain.ts` `recordRetentionWatermark`).
 *
 * Why not a Mongo TTL index: the TTL monitor deletes with no hook, so the
 * oldest surviving event of a chain would look the same after retention as
 * after someone deleted the head of the chain by hand. The watermark — the last
 * pruned `seq` and its `hash`, append-only and HMAC-signed — is what lets
 * `/audit/verify` require the first survivor to link to it.
 *
 * Per chain the prune deletes a CONTIGUOUS prefix: everything up to the highest
 * `seq` whose `createdAt` is past the cutoff. `createdAt` is a replica's clock,
 * not the chain order, so a row a few seconds "newer" under skew can go with
 * the prefix; a gap in the middle of a chain can never be left behind.
 *
 * Order matters: watermark, THEN delete. A prune that dies between the two
 * leaves a watermark at or past the first survivor, which verify treats as an
 * anchor the walk must still reach; the next pass deletes the rest.
 */

import { createLogger, errorMessage, leaderLockKey, type LeaderLockRun } from '@pipeline-builder/api-core';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { config } from '../config/index.js';
import { chainFilter, GENESIS_CHAIN_KEY, recordRetentionWatermark } from '../helpers/audit-chain.js';
import AuditEvent from '../models/audit-event.js';

const logger = createLogger('audit-retention');

/** Outcome of one prune pass. */
export interface AuditRetentionResult {
  /** Chains a watermark was recorded for and pruned. */
  chains: number;
  /** Events deleted. */
  deleted: number;
  /** Chains whose prune threw (retried next pass). */
  failed: number;
}

/**
 * Prune every chain's events older than the retention window. Checks
 * `signal` between chains. Never throws for one chain — that chain is counted
 * in `failed` and retried next pass; the sweep turns `failed > 0` into a thrown
 * cycle so a prune that keeps failing trips `SchedulerJobStale`.
 */
export async function pruneExpiredAuditEvents(
  now: Date = new Date(),
  retentionDays: number = config.audit.retentionDays,
  signal?: AbortSignal,
): Promise<AuditRetentionResult> {
  const result: AuditRetentionResult = { chains: 0, deleted: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const expired = await AuditEvent.aggregate<{ _id: string | null; maxSeq: number | null }>([
    { $match: { createdAt: { $lt: cutoff } } },
    { $group: { _id: '$affectedOrgId', maxSeq: { $max: '$seq' } } },
  ]);

  for (const group of expired) {
    if (signal?.aborted) break;
    if (typeof group.maxSeq !== 'number') continue;
    const chainKey = group._id ?? GENESIS_CHAIN_KEY;
    try {
      const filter = chainFilter(chainKey);
      const last = await AuditEvent.findOne({ ...filter, seq: group.maxSeq }).select('seq hash createdAt').lean();
      if (!last || typeof last.hash !== 'string') continue;
      await recordRetentionWatermark(chainKey, { seq: group.maxSeq, hash: last.hash, createdAt: last.createdAt as Date }, now);
      const res = await AuditEvent.deleteMany({ ...filter, seq: { $lte: group.maxSeq } });
      result.chains += 1;
      result.deleted += res.deletedCount ?? 0;
    } catch (err) {
      result.failed += 1;
      logger.warn('Audit retention prune failed for one chain (retried next pass)', { chainKey, error: errorMessage(err) });
    }
  }
  if (result.chains > 0 || result.failed > 0) logger.info('Audit retention prune pass', { ...result, cutoff: cutoff.toISOString() });
  return result;
}

/** The sweep definition (see services/background-sweeps.ts). */
export function auditRetentionSweep(): IntervalSweepDefinition {
  return {
    name: 'audit-retention-prune',
    lockKey: leaderLockKey('platform', 'audit-retention-prune'),
    // Watermarks are append-only and the delete is a prefix up to one; two
    // pruners leave two valid watermarks and the same surviving suffix.
    concurrencySafe: true,
    intervalMs: config.audit.retentionPruneIntervalMs,
    run: async (run: LeaderLockRun) => {
      const result = await pruneExpiredAuditEvents(new Date(), config.audit.retentionDays, run.signal);
      if (result.failed > 0) {
        throw new Error(`Audit retention prune: ${result.failed} chain(s) failed (${result.chains} pruned); retried next pass`);
      }
    },
  };
}
