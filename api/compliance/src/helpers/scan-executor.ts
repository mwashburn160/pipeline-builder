import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import { schema, db, type RuleTarget } from '@mwashburn160/pipeline-core';
import { eq, and, or, isNull, gt, inArray } from 'drizzle-orm';
import { logComplianceCheck } from './audit-logger';
import { notifyComplianceBlock } from './compliance-notifier';
import { evaluateRules, type ActiveExemption } from '../engine/rule-engine';
import { complianceRuleService } from '../services/compliance-rule-service';

const logger = createLogger('scan-executor');

/** Progress update interval (every N entities). */
const PROGRESS_BATCH_SIZE = 10;

interface EntityRecord {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Execute a compliance scan: fetch entities, evaluate rules, write audit entries.
 * Handles status transitions (pending → running → completed/failed/cancelled).
 */
export async function executeScan(scanId: string): Promise<void> {
  const [scan] = await db
    .select()
    .from(schema.complianceScan)
    .where(eq(schema.complianceScan.id, scanId));

  if (!scan || scan.status !== 'pending') return;

  const isDryRun = scan.triggeredBy === 'rule-dry-run';

  // Mark as running
  await db.update(schema.complianceScan)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(schema.complianceScan.id, scanId));

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
      await db.update(schema.complianceScan)
        .set({ totalEntities })
        .where(eq(schema.complianceScan.id, scanId));

      const rules = await complianceRuleService.findActiveByOrgAndTarget(scan.orgId, target);
      if (rules.length === 0) {
        processedEntities += entities.length;
        passCount += entities.length;
        continue;
      }

      // Batch-fetch approved, non-expired exemptions for all entities in this target
      const entityIds = entities.map(e => e.id).filter(Boolean);
      const exemptionMap = await fetchExemptions(scan.orgId, entityIds);

      for (const entity of entities) {
        // Check for cancellation
        if (processedEntities % PROGRESS_BATCH_SIZE === 0 && processedEntities > 0) {
          const [current] = await db
            .select({ status: schema.complianceScan.status })
            .from(schema.complianceScan)
            .where(eq(schema.complianceScan.id, scanId));
          if (current?.status === 'cancelled') {
            logger.info('Scan cancelled', { scanId });
            return;
          }

          // Update progress
          await db.update(schema.complianceScan)
            .set({ processedEntities, passCount, warnCount, blockCount })
            .where(eq(schema.complianceScan.id, scanId));
        }

        const exemptions = exemptionMap.get(entity.id) ?? [];
        const result = evaluateRules(rules, entity as Record<string, unknown>, exemptions);

        if (result.blocked) blockCount++;
        else if (result.warnings.length > 0) warnCount++;
        else passCount++;

        // Write audit entry (skip for dry-runs)
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
            notifyComplianceBlock(scan.orgId, target, entity.name ?? entity.id, result.violations, '')
              .catch((err) => logger.warn('Notification failed', { error: errorMessage(err) }));
          }
        }

        processedEntities++;
      }
    }

    // Mark completed
    await db.update(schema.complianceScan)
      .set({
        status: 'completed',
        completedAt: new Date(),
        totalEntities,
        processedEntities,
        passCount,
        warnCount,
        blockCount,
      })
      .where(eq(schema.complianceScan.id, scanId));

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
    await db.update(schema.complianceScan)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(schema.complianceScan.id, scanId));
  }
}

/**
 * Fetch entities from plugin or pipeline service via internal HTTP.
 */
async function fetchEntities(target: RuleTarget, orgId: string): Promise<EntityRecord[]> {
  try {
    if (target === 'plugin') {
      return await db
        .select({ id: schema.plugin.id, name: schema.plugin.name })
        .from(schema.plugin)
        .where(and(eq(schema.plugin.isActive, true), or(eq(schema.plugin.orgId, orgId), eq(schema.plugin.orgId, SYSTEM_ORG_ID))))
        .limit(1000) as EntityRecord[];
    }
    return await db
      .select({ id: schema.pipeline.id, name: schema.pipeline.pipelineName })
      .from(schema.pipeline)
      .where(and(eq(schema.pipeline.isActive, true), or(eq(schema.pipeline.orgId, orgId), eq(schema.pipeline.orgId, SYSTEM_ORG_ID))))
      .limit(1000) as EntityRecord[];
  } catch (err) {
    logger.warn(`Failed to fetch ${target} entities`, { orgId, error: errorMessage(err) });
    return [];
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
  const map = new Map<string, ActiveExemption[]>();
  if (entityIds.length === 0) return map;

  try {
    const now = new Date();
    const rows = await db
      .select({
        id: schema.complianceExemption.id,
        ruleId: schema.complianceExemption.ruleId,
        entityId: schema.complianceExemption.entityId,
      })
      .from(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.orgId, orgId),
        inArray(schema.complianceExemption.entityId, entityIds),
        eq(schema.complianceExemption.status, 'approved'),
        or(
          isNull(schema.complianceExemption.expiresAt),
          gt(schema.complianceExemption.expiresAt, now),
        ),
      ));

    for (const row of rows) {
      const entityId = row.entityId ?? '';
      const list = map.get(entityId) ?? [];
      list.push({ id: row.id, ruleId: row.ruleId });
      map.set(entityId, list);
    }
  } catch (err) {
    logger.warn('Failed to fetch exemptions for scan', { orgId, error: errorMessage(err) });
  }

  return map;
}
