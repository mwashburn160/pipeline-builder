// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { schema, db, type RuleTarget } from '@pipeline-builder/pipeline-core';
import { lt } from 'drizzle-orm';
import type { ValidationResult } from '../engine/rule-engine';

const logger = createLogger('audit-logger');

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
  result: ValidationResult,
  scanId?: string,
): Promise<void> {
  const auditResult = result.blocked ? 'block' : result.warnings.length > 0 ? 'warn' : 'pass';

  await db.insert(schema.complianceAuditLog).values({
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
  });
}

/** Default retention window for compliance audit log (days). Override per-deploy via env. */
export const DEFAULT_AUDIT_RETENTION_DAYS = parseInt(
  process.env.COMPLIANCE_AUDIT_RETENTION_DAYS ?? '180',
  10,
);

/**
 * Delete compliance audit log rows older than `maxAgeDays`.
 * Returns the number of rows pruned. Safe to call concurrently — the DELETE
 * is a single atomic statement.
 */
export async function pruneComplianceAudit(maxAgeDays: number = DEFAULT_AUDIT_RETENTION_DAYS): Promise<number> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
    throw new Error(`pruneComplianceAudit: maxAgeDays must be >=1, got ${maxAgeDays}`);
  }
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(schema.complianceAuditLog)
    .where(lt(schema.complianceAuditLog.createdAt, cutoff))
    .returning({ id: schema.complianceAuditLog.id });
  const deleted = result.length;
  logger.info('Pruned compliance audit log', { maxAgeDays, cutoff: cutoff.toISOString(), deleted });
  return deleted;
}

/**
 * Start a daily background prune of the compliance audit log.
 * Returns a `stop()` handle for graceful shutdown / tests.
 *
 * Schedules the next run at a small jitter past 24h to avoid thundering-herd
 * across multiple service replicas. The first run fires `firstRunDelayMs`
 * after start (default: 60s) so service boot isn't blocked.
 */
export function startAuditPruneCron(opts: {
  maxAgeDays?: number;
  intervalMs?: number;
  firstRunDelayMs?: number;
} = {}): { stop: () => void } {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000; // 24 h
  const firstRunDelayMs = opts.firstRunDelayMs ?? 60_000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await pruneComplianceAudit(maxAgeDays);
    } catch (err) {
      logger.error('Audit prune tick failed', { err });
    } finally {
      // Schedule next run (with up to 5 min jitter to spread replicas).
      const jitter = Math.floor(Math.random() * 5 * 60_000);
      timer = setTimeout(tick, intervalMs + jitter);
    }
  };
  timer = setTimeout(tick, firstRunDelayMs);
  logger.info('Audit prune cron scheduled', { maxAgeDays, intervalMs, firstRunDelayMs });

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

