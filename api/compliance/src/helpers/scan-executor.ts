// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { schema, withTenantTx, runWithTenantContext, type RuleTarget } from '@pipeline-builder/pipeline-core';
import { eq, and } from 'drizzle-orm';
import { logComplianceCheck } from './audit-logger.js';
import { notifyComplianceBlock, notifyComplianceWarnings } from './compliance-notifier.js';
import { evaluateRules, type ActiveExemption } from '../engine/rule-engine.js';
import { complianceExemptionService } from '../services/compliance-exemption-service.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

const logger = createLogger('scan-executor');

/** Parse an integer env var, falling back to `fallback` if missing or NaN. */
function parseIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Progress update interval (every N entities). Override via
 *  `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE`. */
const PROGRESS_BATCH_SIZE = parseIntEnv(process.env.COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE, 10);

/** Per-batch concurrency for the entity-evaluation loop. Tunable for very large orgs. */
const SCAN_CONCURRENCY = parseIntEnv(process.env.COMPLIANCE_SCAN_CONCURRENCY, 10);

interface EntityRecord {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Execute a compliance scan: fetch entities, evaluate rules, write audit entries.
 * Handles status transitions (pending → running → completed/failed/cancelled).
 *
 * Runs as a privileged server-side scanner — establishes a sysadmin tenant
 * context for the whole run so the executor can read/write across orgs
 * (the scan record itself carries the orgId that bounds which org's data
 * gets evaluated; RLS isn't the right gate for that — application logic is).
 * Once RLS is FORCE'd, the inner CrudService calls would otherwise default
 * to an empty org_id and return zero rows.
 */
export async function executeScan(scanId: string): Promise<void> {
  return runWithTenantContext({ isSuperAdmin: true }, () => executeScanInternal(scanId));
}

async function executeScanInternal(scanId: string): Promise<void> {
  // Atomic claim: transition pending → running in a single UPDATE … RETURNING.
  // If another scheduler tick (e.g. a peer replica) already grabbed this scan,
  // the RETURNING clause is empty and we bail without touching it. This
  // replaces the read-then-update pattern, which had a race window between
  // SELECT and UPDATE where two workers could claim the same scan.
  const [scan] = await withTenantTx(async (tx) => tx
    .update(schema.complianceScan)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(
      eq(schema.complianceScan.id, scanId),
      eq(schema.complianceScan.status, 'pending'),
    ))
    .returning());

  if (!scan) return;

  // System org is exempt from all compliance scans.
  // Use the same case-insensitive comparison style used in DB queries.
  if ((scan.orgId ?? '').toLowerCase() === SYSTEM_ORG_ID) {
    logger.info('Skipping scan for system org (exempt)', { scanId });
    await withTenantTx(async (tx) => tx.update(schema.complianceScan)
      .set({ status: 'completed', completedAt: new Date(), passCount: 0, warnCount: 0, blockCount: 0, processedEntities: 0, totalEntities: 0 })
      .where(eq(schema.complianceScan.id, scanId)));
    return;
  }

  const isDryRun = scan.triggeredBy === 'rule-dry-run';

  try {
    // Fetch entities based on target
    const targets: RuleTarget[] = scan.target === 'all'
      ? ['plugin', 'pipeline']
      : [scan.target as RuleTarget];

    let passCount = 0;
    let warnCount = 0;
    let blockCount = 0;
    let processedEntities = 0;
    let totalEntities = 0;

    for (const target of targets) {
      const entities = await fetchEntities(target, scan.orgId);
      totalEntities += entities.length;

      // Update total count
      await withTenantTx(async (tx) => tx.update(schema.complianceScan)
        .set({ totalEntities })
        .where(eq(schema.complianceScan.id, scanId)));

      const rules = await complianceRuleService.findActiveByOrgAndTarget(scan.orgId, target);
      if (rules.length === 0) {
        processedEntities += entities.length;
        passCount += entities.length;
        continue;
      }

      // Batch-fetch approved, non-expired exemptions for all entities in this target
      const entityIds = entities.map(e => e.id).filter(Boolean);
      const exemptionMap = await fetchExemptions(scan.orgId, entityIds);

      // Iterate in concurrency-bounded batches. Per-batch we:
      //   1. Check cancellation
      //   2. Run rule evaluation in parallel (CPU-bound but fast; the wins are
      //      in concurrent audit-log writes for large orgs)
      //   3. Aggregate counts + emit one progress update
      //
      // Worker is pure aside from fire-and-forget audit/notification writes;
      // the `for-let-i` outer loop preserves serialized progress updates.
      const concurrency = Math.max(1, SCAN_CONCURRENCY);
      for (let i = 0; i < entities.length; i += concurrency) {
        // Cancellation check before each batch (was every PROGRESS_BATCH_SIZE
        // entities — close enough for batches of ~10).
        const [current] = await withTenantTx(async (tx) => tx
          .select({ status: schema.complianceScan.status })
          .from(schema.complianceScan)
          .where(eq(schema.complianceScan.id, scanId)));
        if (current?.status === 'cancelled') {
          logger.info('Scan cancelled', { scanId });
          return;
        }

        const slice = entities.slice(i, i + concurrency);
        const settled = await Promise.allSettled(slice.map(async (entity) => {
          const exemptions = exemptionMap.get(entity.id) ?? [];
          const result = evaluateRules(rules, entity as Record<string, unknown>, exemptions);

          if (!isDryRun) {
            logComplianceCheck(
              scan.orgId,
              scan.userId ?? 'system',
              target,
              'scan',
              entity.id,
              entity.name,
              result,
              scanId,
            ).catch((err) => logger.warn('Audit write failed', { error: errorMessage(err) }));

            if (result.blocked) {
              notifyComplianceBlock(scan.orgId, target, entity.name ?? entity.id, result.violations)
                .catch((err) => logger.warn('Notification failed', { error: errorMessage(err) }));
            } else if (result.warnings.length > 0) {
              notifyComplianceWarnings(scan.orgId, target, entity.name ?? entity.id, result.warnings)
                .catch((err) => logger.warn('Warning notification failed', { error: errorMessage(err) }));
            }
          }
          return result;
        }));

        // Aggregate batch results. An entity whose rules could not be evaluated
        // is NOT a pass — fail closed and count it as blocked so it surfaces,
        // rather than a soft warning that reads as "mostly fine".
        for (const s of settled) {
          if (s.status === 'fulfilled') {
            const r = s.value;
            if (r.blocked) blockCount++;
            else if (r.warnings.length > 0) warnCount++;
            else passCount++;
          } else {
            blockCount++;
            logger.error('Rule evaluation failed for entity — counting as blocked', { error: errorMessage(s.reason) });
          }
          processedEntities++;
        }

        // One progress update per batch (every PROGRESS_BATCH_SIZE entities of work,
        // not per-entity — fewer DB writes for the same UX).
        //
        // Gate the UPDATE on status='running' so a concurrent cancellation that
        // flipped the row to 'cancelled' isn't silently overwritten. Zero rows
        // updated = the scan was cancelled (or otherwise transitioned out of
        // running) — bail out of the loop.
        if (processedEntities % PROGRESS_BATCH_SIZE === 0 || i + concurrency >= entities.length) {
          const progressRows = await withTenantTx(async (tx) => tx.update(schema.complianceScan)
            .set({ processedEntities, passCount, warnCount, blockCount })
            .where(and(
              eq(schema.complianceScan.id, scanId),
              eq(schema.complianceScan.status, 'running'),
            ))
            .returning({ id: schema.complianceScan.id }));
          if (progressRows.length === 0) {
            logger.info('Scan no longer running, aborting executor', { scanId });
            return;
          }
        }
      }
    }

    // Mark completed — only if still running (don't clobber a concurrent cancel).
    const completedRows = await withTenantTx(async (tx) => tx.update(schema.complianceScan)
      .set({
        status: 'completed',
        completedAt: new Date(),
        totalEntities,
        processedEntities,
        passCount,
        warnCount,
        blockCount,
      })
      .where(and(
        eq(schema.complianceScan.id, scanId),
        eq(schema.complianceScan.status, 'running'),
      ))
      .returning({ id: schema.complianceScan.id }));

    if (completedRows.length === 0) {
      logger.info('Scan no longer running at completion (likely cancelled)', { scanId });
      return;
    }

    logger.info('Scan completed', {
      scanId,
      totalEntities,
      passCount,
      warnCount,
      blockCount,
      isDryRun,
    });
  } catch (err) {
    logger.error('Scan failed', { scanId, error: errorMessage(err) });
    // Only flip to 'failed' if the scan is still running — preserve a
    // concurrent cancellation rather than overwriting it.
    await withTenantTx(async (tx) => tx.update(schema.complianceScan)
      .set({ status: 'failed', completedAt: new Date() })
      .where(and(
        eq(schema.complianceScan.id, scanId),
        eq(schema.complianceScan.status, 'running'),
      )));
  }
}

/** Hard cap on entities fetched per target per scan. Larger orgs are scanned
 *  truncated — we log a warn so operators can detect this. The scan record
 *  itself has no metadata column for a `truncated: true` flag (would need a
 *  schema change), so the warning is the only signal until that lands. */
const ENTITY_FETCH_CAP = 1000;

/**
 * Fetch entities from plugin or pipeline service via internal HTTP.
 * If the result length equals `ENTITY_FETCH_CAP` we assume truncation and warn.
 */
async function fetchEntities(target: RuleTarget, orgId: string): Promise<EntityRecord[]> {
  try {
    // Only scan the org's own entities — system org entities are exempt from compliance
    let rows: EntityRecord[];
    if (target === 'plugin') {
      rows = await withTenantTx(async (tx) => tx
        .select({ id: schema.plugin.id, name: schema.plugin.name })
        .from(schema.plugin)
        .where(and(eq(schema.plugin.isActive, true), eq(schema.plugin.orgId, orgId)))
        .limit(ENTITY_FETCH_CAP)) as EntityRecord[];
    } else {
      rows = await withTenantTx(async (tx) => tx
        .select({ id: schema.pipeline.id, name: schema.pipeline.pipelineName })
        .from(schema.pipeline)
        .where(and(eq(schema.pipeline.isActive, true), eq(schema.pipeline.orgId, orgId)))
        .limit(ENTITY_FETCH_CAP)) as EntityRecord[];
    }

    if (rows.length >= ENTITY_FETCH_CAP) {
      logger.warn('Scan entity fetch hit cap — results truncated', {
        orgId, target, cap: ENTITY_FETCH_CAP,
      });
    }
    return rows;
  } catch (err) {
    // Do NOT swallow to `[]` — that made a failed entity load look like "0
    // entities, all clear" and the scan completed green (false-positive pass).
    // Rethrow so the caller marks the scan `failed` (honest gating).
    logger.error(`Failed to fetch ${target} entities`, { orgId, error: errorMessage(err) });
    throw err;
  }
}

/**
 * Batch-fetch approved, non-expired exemptions for a set of entities.
 * Returns a Map of entityId → ActiveExemption[].
 */
async function fetchExemptions(
  orgId: string,
  entityIds: string[],
): Promise<Map<string, ActiveExemption[]>> {
  if (entityIds.length === 0) return new Map();
  try {
    // Single source of truth for the active-exemption predicate.
    return await complianceExemptionService.getActiveExemptionsForEntities(orgId, entityIds);
  } catch (err) {
    logger.warn('Failed to fetch exemptions for scan', { orgId, error: errorMessage(err) });
    return new Map();
  }
}
