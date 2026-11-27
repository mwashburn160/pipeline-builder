// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createScheduler, type Scheduler, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS, type ComplianceCheckVerdict } from '@pipeline-builder/api-core';
import { schema, withTenantTx, runWithTenantContext, type RuleTarget } from '@pipeline-builder/pipeline-data';
import { and, inArray, lt, ne } from 'drizzle-orm';
import { config } from '../config.js';
import type { RuleValidationResult } from '../engine/rule-engine.js';

const logger = createLogger('compliance-check-log');

/**
 * Write a compliance check result to the audit log.
 */
export async function logComplianceCheck(
  orgId: string,
  userId: string,
  target: RuleTarget,
  action: string,
  entityId: string | undefined,
  entityName: string | undefined,
  result: RuleValidationResult,
  scanId?: string,
): Promise<void> {
  const auditResult: ComplianceCheckVerdict = result.blocked ? 'block' : result.warnings.length > 0 ? 'warn' : 'pass';

  await withTenantTx(async (tx) => tx.insert(schema.complianceAuditLog).values({
    orgId,
    userId,
    target,
    action,
    entityId: entityId ?? null,
    entityName: entityName ?? null,
    result: auditResult,
    violations: [...result.violations, ...result.warnings] as unknown as Record<string, unknown>[],
    ruleCount: result.rulesEvaluated,
    scanId: scanId ?? null,
  }));
}

/** Scan statuses that will never change again — the only rows the prune may drop. */
const FINISHED_SCAN_STATUSES = ['completed', 'failed', 'cancelled'] as const;

function retentionCutoff(fn: string, maxAgeDays: number): Date {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
    throw new Error(`${fn}: maxAgeDays must be >=1, got ${maxAgeDays}`);
  }
  return new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
}

/** Default retention window for compliance audit log (days); `COMPLIANCE_AUDIT_RETENTION_DAYS`. */
export const DEFAULT_AUDIT_RETENTION_DAYS = config.auditRetentionDays;

/**
 * Delete compliance audit log rows older than `maxAgeDays`.
 * Returns the number of rows pruned. Safe to call concurrently — the DELETE
 * is a single atomic statement.
 */
export async function pruneComplianceAudit(maxAgeDays: number = DEFAULT_AUDIT_RETENTION_DAYS): Promise<number> {
  const cutoff = retentionCutoff('pruneComplianceAudit', maxAgeDays);
  // Cron-driven prune deletes rows across every org; runs as a privileged
  // background task with no caller identity. Establish a sysadmin context
  // so the DELETE bypasses any per-org RLS policy once FORCE'd.
  const result = await runWithTenantContext({ isSuperAdmin: true }, () =>
    withTenantTx(async (tx) => tx
      .delete(schema.complianceAuditLog)
      .where(lt(schema.complianceAuditLog.createdAt, cutoff))
      .returning({ id: schema.complianceAuditLog.id })),
  );
  const deleted = result.length;
  logger.info('Pruned compliance audit log', { maxAgeDays, cutoff: cutoff.toISOString(), deleted });
  return deleted;
}

/**
 * Delete FINISHED compliance scans older than `maxAgeDays` (same window as the
 * audit log). A row is written per manual scan, per scheduled tick and per rule
 * create/update auto-rescan, so without this the table only grew — and its rows
 * outlived the audit rows that reference them by `scan_id`. A `pending` /
 * `running` row is never dropped, however old: that is a stuck scan someone
 * needs to see, not history.
 */
export async function pruneFinishedScans(maxAgeDays: number = DEFAULT_AUDIT_RETENTION_DAYS): Promise<number> {
  const cutoff = retentionCutoff('pruneFinishedScans', maxAgeDays);
  const result = await runWithTenantContext({ isSuperAdmin: true }, () =>
    withTenantTx(async (tx) => tx
      .delete(schema.complianceScan)
      .where(and(
        lt(schema.complianceScan.createdAt, cutoff),
        inArray(schema.complianceScan.status, [...FINISHED_SCAN_STATUSES]),
      ))
      .returning({ id: schema.complianceScan.id })),
  );
  logger.info('Pruned finished compliance scans', { maxAgeDays, cutoff: cutoff.toISOString(), deleted: result.length });
  return result.length;
}

/**
 * Delete compliance notification-log rows older than `maxAgeDays`. One row per
 * notification sent; it is a delivery record, not a compliance verdict, so it
 * keeps no longer than the audit log it sits beside. A `pending` row is a parked
 * digest entry — undelivered work, not history — and is never dropped.
 */
export async function pruneNotificationLog(maxAgeDays: number = DEFAULT_AUDIT_RETENTION_DAYS): Promise<number> {
  const cutoff = retentionCutoff('pruneNotificationLog', maxAgeDays);
  const result = await runWithTenantContext({ isSuperAdmin: true }, () =>
    withTenantTx(async (tx) => tx
      .delete(schema.complianceNotificationLog)
      .where(and(
        lt(schema.complianceNotificationLog.createdAt, cutoff),
        ne(schema.complianceNotificationLog.status, 'pending'),
      ))
      .returning({ id: schema.complianceNotificationLog.id })),
  );
  logger.info('Pruned compliance notification log', { maxAgeDays, cutoff: cutoff.toISOString(), deleted: result.length });
  return result.length;
}

/**
 * Start a daily background prune of the compliance history tables: the audit
 * log, finished scans and the notification log, all on one retention window.
 * Returns a `stop()` handle for graceful shutdown / tests.
 *
 * The first run fires `firstRunDelayMs` after start (default: 60s) so service
 * boot isn't blocked. Leader-locked so only one replica prunes per window (the
 * DELETE is idempotent, so a lock-less deployment is still correct).
 */
export function startAuditPruneCron(opts: {
  maxAgeDays?: number;
  intervalMs?: number;
  firstRunDelayMs?: number;
} = {}): Scheduler {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000; // 24 h
  const firstRunDelayMs = opts.firstRunDelayMs ?? 60_000;

  const scheduler = createScheduler({
    name: 'compliance-audit-prune',
    intervalMs,
    startupDelayMs: firstRunDelayMs,
    lock: { key: leaderLockKey('compliance', 'audit-prune'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    // Sequential, and a throw propagates: the scheduler then records no success
    // for the cycle, which is what SchedulerJobStale watches.
    run: async () => {
      await pruneComplianceAudit(maxAgeDays);
      await pruneFinishedScans(maxAgeDays);
      await pruneNotificationLog(maxAgeDays);
    },
  });
  scheduler.start();
  logger.info('Audit prune cron scheduled', { maxAgeDays, intervalMs, firstRunDelayMs });
  return scheduler;
}
