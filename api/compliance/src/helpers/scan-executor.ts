// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { schema, withTenantTx, runWithTenantContext, type RuleTarget } from '@pipeline-builder/pipeline-data';
import { eq, and, gt, asc } from 'drizzle-orm';
import { logComplianceCheck } from './audit-logger.js';
import { notifyComplianceBlock, notifyComplianceWarnings } from './compliance-notifier.js';
import { resolveParentOrgId } from './org-hierarchy-client.js';
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
    // Resolve the org's parent once for the whole scan so rule lookup includes
    // the parent's `propagateToChildren` rules — matching the live validation
    // and entity-event paths (which read it off the request JWT). Scans are
    // detached from any request, so this is an internal platform lookup;
    // fail-soft to undefined (own-rules-only) if platform is unreachable.
    const parentOrgId = await resolveParentOrgId(scan.orgId);

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

      const rules = await complianceRuleService.findActiveByOrgAndTarget(scan.orgId, target, parentOrgId);
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

/** Page size for entity pagination. Entities are fetched in keyset-paginated
 *  pages of this size and ALL pages are evaluated — there is no truncation.
 *  Override via `COMPLIANCE_SCAN_ENTITY_PAGE_SIZE`. */
const ENTITY_PAGE_SIZE = parseIntEnv(process.env.COMPLIANCE_SCAN_ENTITY_PAGE_SIZE, 1000);

/** Absolute safety bound on total entities materialized per target per scan.
 *  Pagination evaluates every entity; this only guards against pathological
 *  unbounded memory. Exceeding it FAILS the scan (honest terminal state) rather
 *  than silently truncating to a green "all pass". Override via
 *  `COMPLIANCE_SCAN_ENTITY_MAX_TOTAL`. */
const ENTITY_MAX_TOTAL = parseIntEnv(process.env.COMPLIANCE_SCAN_ENTITY_MAX_TOTAL, 100_000);

/**
 * Fetch ALL active entities for a target via keyset (id-ordered) pagination.
 *
 * Previously this issued a single `.limit(1000)` query and silently truncated
 * larger orgs to the first 1000 rows — the scan then reported `status:'completed'`
 * with a `totalEntities` that only counted the truncated slice, i.e. an
 * authoritative green "all pass" that never evaluated the rest. This loops until
 * a short page signals the end, so every entity is evaluated. `ENTITY_MAX_TOTAL`
 * is a pathological-memory guard: if an org exceeds it we throw so the caller
 * marks the scan `failed` — never a green scan that skipped entities.
 */
async function fetchEntities(target: RuleTarget, orgId: string): Promise<EntityRecord[]> {
  const pageSize = Math.max(1, ENTITY_PAGE_SIZE);
  const all: EntityRecord[] = [];
  // Keyset cursor: the id of the last row of the previous page (id-ordered asc).
  // Keyset (id > cursor) rather than OFFSET so page N doesn't get slower as the
  // table grows.
  let cursor: string | undefined;
  try {
    // Only scan the org's own entities — system org entities are exempt from compliance
    for (;;) {
      let rows: EntityRecord[];
      if (target === 'plugin') {
        rows = await withTenantTx(async (tx) => tx
          .select({ id: schema.plugin.id, name: schema.plugin.name })
          .from(schema.plugin)
          .where(and(
            eq(schema.plugin.isActive, true),
            eq(schema.plugin.orgId, orgId),
            ...(cursor === undefined ? [] : [gt(schema.plugin.id, cursor)]),
          ))
          .orderBy(asc(schema.plugin.id))
          .limit(pageSize)) as EntityRecord[];
      } else {
        rows = await withTenantTx(async (tx) => tx
          .select({ id: schema.pipeline.id, name: schema.pipeline.pipelineName })
          .from(schema.pipeline)
          .where(and(
            eq(schema.pipeline.isActive, true),
            eq(schema.pipeline.orgId, orgId),
            ...(cursor === undefined ? [] : [gt(schema.pipeline.id, cursor)]),
          ))
          .orderBy(asc(schema.pipeline.id))
          .limit(pageSize)) as EntityRecord[];
      }

      all.push(...rows);

      // A short page (fewer rows than requested) is the last page.
      if (rows.length < pageSize) break;

      // Advance the cursor to the last id we saw. If for some reason the id is
      // missing we can't paginate safely — fail rather than loop forever or
      // silently drop the tail.
      const lastId = rows[rows.length - 1]?.id;
      if (!lastId) {
        throw new Error(`cannot paginate ${target} entities: last row has no id`);
      }
      cursor = lastId;

      // Pathological-memory guard. Failing here is deliberate: a truncated green
      // scan (the old behavior) is a false pass; an honest failure is not.
      if (all.length > ENTITY_MAX_TOTAL) {
        throw new Error(
          `entity count for ${target} exceeded safety bound ${ENTITY_MAX_TOTAL}`,
        );
      }
    }
    return all;
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
    // Do NOT swallow to an empty Map. An empty Map means "no entity has an
    // approved exemption", so a transient DB error here would make every entity
    // with a VALID approved exemption evaluate as a violation/block and fire
    // notifyComplianceBlock — fabricated blocks from an infra failure. Rethrow
    // so the caller marks the scan `failed` (matches fetchEntities' fail-closed
    // choice) rather than emitting a dishonest report.
    logger.error('Failed to fetch exemptions for scan', { orgId, error: errorMessage(err) });
    throw err;
  }
}
