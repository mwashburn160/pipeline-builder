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
 *   - Fail-closed: EVERY cascade leg is a hard gate — billing, quota, the audit
 *     archive, each Postgres table and each Mongo collection. If any failed to
 *     tear down, the org is left soft-deleted (NOT hard-deleted) and retried
 *     next sweep: once the org doc is gone nothing keys a retry, so a row left
 *     behind then would be orphaned forever (and a live subscription would
 *     outlive its org). Only the message-blob purge stays best-effort.
 *   - Never throws: a per-org error is logged and the sweep continues; the
 *     interval can't be crashed by one bad org or a transient datastore blip.
 *   - Runs on `createScheduler` (same-pod re-entrancy guard: a sweep slower
 *     than its interval can't overlap itself) under the cross-pod leader lock.
 *   - The recovery snapshot in `deleted_org_snapshots` is deliberately RETAINED
 *     past purge — it is the post-deletion recovery artifact.
 */

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { IntervalSweepDefinition } from './background-sweeps.js';
import { cascadeDeleteOrg, type CascadeReport } from './org-cascade-service.js';
import { organizationService } from './organization-service.js';
import { config } from '../config/index.js';
import { recordAuditEvent } from '../helpers/audit.js';
import { Organization } from '../models/index.js';

const logger = createLogger('org-purge');

/** Cross-pod leader-lock key + TTL for the DESTRUCTIVE purge sweep. Only one
 *  replica may run the cascade per window (otherwise N pods run it in parallel,
 *  racing the same fail-closed teardown). TTL floored so a tiny test interval
 *  can't create a near-zero lock lifetime. */
const LOCK_KEY = 'platform:leader:org-purge';


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
    ...(report.mongoFailures.length > 0 ? { mongoFailures: report.mongoFailures } : {}),
    quotaOk: report.quota.ok,
    billingOk: report.billing.ok,
    auditArchived: report.auditArchive.archived ?? 0,
    kmsOrphanFlagged: !!report.kms,
  };
}

/** Every cascade leg that failed and so blocks the hard delete. */
export function failedTeardownLegs(report: CascadeReport): string[] {
  return [
    !report.billing.ok ? 'billing' : null,
    !report.quota.ok ? 'quota' : null,
    !report.auditArchive.ok ? 'audit-archive' : null,
    ...Object.entries(report.postgres).filter(([, r]) => !r.ok).map(([name]) => `postgres:${name}`),
    ...report.mongoFailures.map((name) => `mongo:${name}`),
  ].filter((leg): leg is string => leg !== null);
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

      // FAIL CLOSED: any failed teardown leg defers the hard delete — leave the
      // org soft-deleted and retry next sweep (see the module header).
      const failedLegs = failedTeardownLegs(report);
      if (failedLegs.length > 0) {
        logger.error(`Org purge deferred for ${orgId} — ${failedLegs.join(' + ')} teardown failed; org left soft-deleted, will retry`, {
          orgId, failedLegs,
        });
        result.deferred += 1;
        continue;
      }

      await organizationService.delete(orgId);
      logger.info('Org purged (hard-deleted after retention window)', { orgId });
      result.purged += 1;

      // Audit the hard delete — the single most destructive lifecycle action.
      // This is a BACKGROUND sweep (no `req`), so it records with a synthetic
      // `org-purge` actor and the system org as the actor org. Written AFTER the
      // cascade's audit delete, so it remains the durable proof the org was
      // purged. Durable fire-and-forget: an audit failure must NEVER fail/abort the
      // purge (the delete already committed above); a failed write is spooled
      // and re-appended rather than lost.
      recordAuditEvent({
        action: 'admin.org.delete',
        actorId: 'org-purge',
        orgId: SYSTEM_ORG_ID,
        affectedOrgId: orgId,
        outcome: 'success',
        details: purgeAuditDetails(report),
      });
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
 * The purge as a background sweep (see services/background-sweeps.ts). Under
 * the cross-pod lock so only ONE replica runs the destructive cascade per window.
 */
export function orgPurgeSweep(intervalMs: number = config.organization.purgeSweepIntervalMs): IntervalSweepDefinition {
  return {
    name: 'org-purge-sweep',
    lockKey: LOCK_KEY,
    intervalMs,
    run: async () => { await purgeExpiredOrgs(); },
  };
}
