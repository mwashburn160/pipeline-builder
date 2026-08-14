// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org purge sweep — durably runs the destructive delete cascade for orgs whose
 * SOFT-DELETE retention window has lapsed.
 *
 * `DELETE /organization/:id` no longer hard-deletes: it soft-deletes (sets
 * `deletedAt`/`purgeAfter`, snapshots the org, cuts sessions). This sweep is the
 * back half — it finds every org with `purgeAfter <= now` and runs the EXISTING
 * fail-closed cascade ({@link cascadeDeleteOrg}) + hard delete per org.
 *
 * Safety properties (mirrors the invitation reaper):
 *   - Idempotent: an org already mid-purge (cascade ran, hard delete pending) is
 *     picked up again next tick; a fully-purged org no longer matches the scan.
 *   - Fail-closed: the cascade's billing/quota legs are HARD GATES — if either
 *     failed to tear down, the org is left soft-deleted (NOT hard-deleted) and
 *     retried next sweep, so a live subscription never outlives its org.
 *   - Never throws: a per-org error is logged and the sweep continues; the
 *     interval can't be crashed by one bad org or a transient datastore blip.
 *   - The recovery snapshot in `deleted_org_snapshots` is deliberately RETAINED
 *     past purge — it is the post-deletion recovery artifact.
 */

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { auditService } from './audit-service.js';
import { cascadeDeleteOrg, type CascadeReport } from './org-cascade-service.js';
import { organizationService } from './organization-service.js';
import { config } from '../config/index.js';
import { Organization } from '../models/index.js';
import { runWithLeaderLock } from '../utils/leader-lock.js';

const logger = createLogger('org-purge');

/** Cross-pod leader-lock key + TTL for the DESTRUCTIVE purge sweep. Only one
 *  replica may run the cascade per window (otherwise N pods run it in parallel,
 *  racing the same fail-closed teardown). TTL floored so a tiny test interval
 *  can't create a near-zero lock lifetime. */
const LOCK_KEY = 'platform:leader:org-purge';

let timer: ReturnType<typeof setInterval> | null = null;

/** Outcome of one {@link purgeExpiredOrgs} pass (for logging/tests). */
export interface PurgeSweepResult {
  scanned: number;
  purged: number;
  deferred: number;
  failed: number;
}

/**
 * Distill a {@link CascadeReport} into a SECRET-FREE audit `details` summary:
 * per-store row COUNTS and boolean status flags only. Deliberately omits the
 * KMS `keyRef` (a key id/ARN can embed an AWS account id) and any error strings
 * that could carry sensitive fragments — the audit trail records WHAT was purged,
 * not any credential/identifier.
 */
function purgeAuditDetails(report: CascadeReport): Record<string, unknown> {
  const postgres: Record<string, number> = {};
  const postgresFailures: string[] = [];
  for (const [name, r] of Object.entries(report.postgres)) {
    if (r.ok) postgres[name] = r.rowCount ?? 0;
    else postgresFailures.push(name);
  }
  return {
    trigger: 'purge-sweep',
    postgres,
    ...(postgresFailures.length > 0 ? { postgresFailures } : {}),
    mongo: report.mongo,
    quotaOk: report.quota.ok,
    billingOk: report.billing.ok,
    auditArchived: report.auditArchive.archived ?? 0,
    kmsOrphanFlagged: !!report.kms,
  };
}

/**
 * Find every soft-deleted org whose `purgeAfter` has lapsed and run the
 * fail-closed cascade + hard delete for each. Returns a tally. Never throws.
 */
export async function purgeExpiredOrgs(): Promise<PurgeSweepResult> {
  const result: PurgeSweepResult = { scanned: 0, purged: 0, deferred: 0, failed: 0 };
  let expired: Array<{ _id: unknown; name?: string }>;
  try {
    expired = await Organization.find({
      deletedAt: { $ne: null },
      purgeAfter: { $lte: new Date() },
    }).select('_id name').lean();
  } catch (err) {
    logger.warn('Org purge sweep scan failed', { error: errorMessage(err) });
    return result;
  }

  result.scanned = expired.length;

  for (const org of expired) {
    const orgId = String(org._id);
    try {
      // Reuse the EXISTING destructive cascade. Sysadmin actor context (system
      // org) so the Postgres RLS bypass applies, exactly like the interactive
      // delete path did.
      const report = await cascadeDeleteOrg(orgId, SYSTEM_ORG_ID);

      // FAIL CLOSED: if a billing/quota teardown OR the audit-trail archive
      // failed, do NOT hard-delete — leave the org soft-deleted and retry next
      // sweep. A live subscription must never outlive its org, and the forensic
      // audit trail must never be destroyed without a durable archive copy.
      if (!report.billing.ok || !report.quota.ok || !report.auditArchive.ok) {
        const failedLegs = [
          !report.billing.ok ? 'billing' : null,
          !report.quota.ok ? 'quota' : null,
          !report.auditArchive.ok ? 'audit-archive' : null,
        ].filter(Boolean).join(' + ');
        logger.error(`Org purge deferred for ${orgId} — ${failedLegs} teardown failed; org left soft-deleted, will retry`, {
          orgId, failedLegs,
        });
        result.deferred += 1;
        continue;
      }

      await organizationService.delete(orgId);
      logger.info('Org purged (hard-deleted after retention window)', { orgId });
      result.purged += 1;

      // Audit the hard delete — the single most destructive lifecycle action.
      // This is a BACKGROUND sweep (no `req`), so go through the service directly
      // with a synthetic `org-purge` actor and the system org as the actor org.
      // The `admin.org.delete` row survives the cascade's audit-wipe (it's the
      // `$ne` carve-out) so it remains the durable proof the org was purged.
      // Fire-and-forget: an audit failure must NEVER fail/abort the purge, so it
      // is isolated in its own try/catch (the delete already committed above).
      try {
        await auditService.createEvent({
          action: 'admin.org.delete',
          actorId: 'org-purge',
          orgId: SYSTEM_ORG_ID,
          affectedOrgId: orgId,
          outcome: 'success',
          details: purgeAuditDetails(report),
        });
      } catch (auditErr) {
        logger.error('Failed to record admin.org.delete audit event', { orgId, error: errorMessage(auditErr) });
      }
    } catch (err) {
      // Per-org failure must not abort the sweep — log and move on.
      logger.error('Org purge failed for one org (continuing)', { orgId, error: errorMessage(err) });
      result.failed += 1;
    }
  }

  if (result.purged > 0 || result.deferred > 0 || result.failed > 0) {
    logger.info('Org purge sweep complete', { ...result });
  }
  return result;
}

/**
 * Start the periodic purge sweep. Idempotent — a second call is a no-op while a
 * timer is live. Runs one immediate sweep, then repeats on the interval, which
 * is `.unref()`'d so it never keeps Node alive in tests/worker scripts.
 * Returns the stop function; wire it to SIGTERM in index.ts.
 */
export function startOrgPurgeSweep(intervalMs: number = config.organization.purgeSweepIntervalMs): () => void {
  if (timer) return stopOrgPurgeSweep;
  // TTL comfortably exceeds one sweep; floored so a small interval can't make it
  // near-zero. Cross-pod lock so only ONE replica runs the destructive cascade.
  const lockTtlMs = Math.max(intervalMs, 60_000);
  const runLocked = () => void runWithLeaderLock(LOCK_KEY, lockTtlMs, async () => { await purgeExpiredOrgs(); });
  timer = setInterval(runLocked, intervalMs).unref();
  runLocked(); // immediate first sweep (leader-locked)
  logger.info('Org purge sweep started', { intervalMs });
  return stopOrgPurgeSweep;
}

/** Stop the periodic purge sweep. Idempotent. */
export function stopOrgPurgeSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Org purge sweep stopped');
  }
}
