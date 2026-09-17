// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, envInt, errorMessage, SYSTEM_ORG_ID, toComplianceAttributes } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { schema, withTenantTx, runWithTenantContext, type RuleTarget } from '@pipeline-builder/pipeline-data';
import { eq, and, gt, lt, asc } from 'drizzle-orm';
import { logComplianceCheck } from './compliance-check-log.js';
import { notifyComplianceBlock, notifyComplianceWarnings } from './compliance-notifier.js';
import { resolveParentOrgId } from './org-hierarchy-client.js';
import { evaluateRules, type ActiveExemption } from '../engine/rule-engine.js';
import { complianceExemptionService } from '../services/compliance-exemption-service.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

const logger = createLogger('scan-executor');

/** Progress update interval (every N entities). Override via
 *  `COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE`. */
const PROGRESS_BATCH_SIZE = envInt('COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE', 10, { min: 1 });

/** Per-batch concurrency for the entity-evaluation loop. Tunable for very large orgs. */
const SCAN_CONCURRENCY = envInt('COMPLIANCE_SCAN_CONCURRENCY', 10, { min: 1 });

/** An entity to evaluate: its id + display name, and the compliance-safe
 *  attribute projection the rules run against. */
interface EntityRecord {
  id: string;
  name?: string;
  attributes: Record<string, unknown>;
}

/**
 * Project a full plugin/pipeline row into the evaluation record. `attributes`
 * goes through api-core's `toComplianceAttributes` — byte-for-byte what the
 * plugin/pipeline services emit on the live entity-event path — so a scan
 * evaluates the same field names (`name`, `pipelineName`, `env` keys, …) with the
 * same secret-value redaction. Selecting only `{id, name}` (the old shape) left
 * every field-based rule evaluating against nothing.
 */
function toEntityRecord(row: Record<string, unknown>, name: unknown): EntityRecord {
  return {
    id: row.id as string,
    name: typeof name === 'string' ? name : undefined,
    attributes: toComplianceAttributes(row) as Record<string, unknown>,
  };
}

/** A `running` scan whose `startedAt` is older than this is presumed orphaned
 *  (its executor crashed / the pod died mid-scan) and is failed by
 *  {@link recoverStaleScans}. Override via `COMPLIANCE_SCAN_STALE_TIMEOUT_MS`. */
const STALE_SCAN_TIMEOUT_MS = envInt('COMPLIANCE_SCAN_STALE_TIMEOUT_MS', 2 * 60 * 60 * 1000, { min: 60_000 });

/**
 * Fail scans stuck in `running` past {@link STALE_SCAN_TIMEOUT_MS}.
 *
 * The executor only leaves `running` through its own terminal UPDATEs, so a
 * process crash mid-scan stranded the row in `running` forever — it never
 * completed, showed as in-progress in the UI, and (because rule-change scans
 * coalesce on an existing pending/running scan for the org+target) silently
 * suppressed every later rule-change re-scan for that org. Called at the start
 * of each scheduler sweep. The UPDATE is conditional on `status='running'`, so it
 * can't clobber a scan that finished or was cancelled concurrently; a live scan
 * that genuinely outruns the timeout sees its next progress write match zero
 * rows and aborts cleanly. Returns the number of scans recovered.
 */
export async function recoverStaleScans(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SCAN_TIMEOUT_MS);
  const recovered = await runWithTenantContext({ isSuperAdmin: true }, () =>
    withTenantTx(async (tx) => tx.update(schema.complianceScan)
      .set({ status: 'failed', completedAt: now })
      .where(and(
        eq(schema.complianceScan.status, 'running'),
        lt(schema.complianceScan.startedAt, cutoff),
      ))
      .returning({ id: schema.complianceScan.id })));
  if (recovered.length > 0) {
    incCounter('compliance_scans_total', { outcome: 'failed' }, recovered.length);
    logger.warn('Recovered stale running scans (marked failed)', {
      count: recovered.length,
      scanIds: recovered.map((r: { id: string }) => r.id),
      timeoutMs: STALE_SCAN_TIMEOUT_MS,
    });
  }
  return recovered.length;
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

  // Domain metric — a scan was claimed and is now executing. Tagged by outcome
  // only; orgId is deliberately omitted to keep label cardinality bounded.
  incCounter('compliance_scans_total', { outcome: 'started' });

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
    // detached from any request, so this is an internal platform lookup.
    // Fail-CLOSED: a resolve FAILURE throws here (caught below → scan marked
    // `failed`) rather than degrading to own-rules-only, which would skip a
    // team's inherited blocking rules and stamp a false-pass. A genuine root
    // org resolves to undefined (no parent) and proceeds normally.
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
          // Terminal outcome — without it `started` never balances against the
          // sum of terminal outcomes, so a cancellation looks like a scan that
          // silently vanished.
          incCounter('compliance_scans_total', { outcome: 'cancelled' });
          return;
        }

        const slice = entities.slice(i, i + concurrency);
        const settled = await Promise.allSettled(slice.map(async (entity) => {
          const exemptions = exemptionMap.get(entity.id) ?? [];
          const result = evaluateRules(rules, entity.attributes, exemptions);

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
            incCounter('compliance_scans_total', { outcome: 'cancelled' });
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
      incCounter('compliance_scans_total', { outcome: 'cancelled' });
      return;
    }

    // Domain metric — scan reached a terminal completed state. `passed` means
    // the scan found NO blocking violations; a completed scan with blocks is a
    // materially different outcome and used to be counted as `passed` too,
    // which made the metric useless for "are we blocking anything?".
    incCounter('compliance_scans_total', { outcome: blockCount > 0 ? 'blocked' : 'passed' });

    logger.info('Scan completed', {
      scanId,
      totalEntities,
      passCount,
      warnCount,
      blockCount,
      isDryRun,
    });
  } catch (err) {
    // Domain metric — scan hit an unrecoverable error and will be marked failed.
    incCounter('compliance_scans_total', { outcome: 'failed' });
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
const ENTITY_PAGE_SIZE = envInt('COMPLIANCE_SCAN_ENTITY_PAGE_SIZE', 1000, { min: 1 });

/** Absolute safety bound on total entities materialized per target per scan.
 *  Pagination evaluates every entity; this only guards against pathological
 *  unbounded memory. Exceeding it FAILS the scan (honest terminal state) rather
 *  than silently truncating to a green "all pass". Override via
 *  `COMPLIANCE_SCAN_ENTITY_MAX_TOTAL`. */
const ENTITY_MAX_TOTAL = envInt('COMPLIANCE_SCAN_ENTITY_MAX_TOTAL', 100_000, { min: 1 });

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
        const page = await withTenantTx(async (tx) => tx
          .select()
          .from(schema.plugin)
          .where(and(
            eq(schema.plugin.isActive, true),
            eq(schema.plugin.orgId, orgId),
            ...(cursor === undefined ? [] : [gt(schema.plugin.id, cursor)]),
          ))
          .orderBy(asc(schema.plugin.id))
          .limit(pageSize));
        rows = page.map((r: typeof schema.plugin.$inferSelect) => toEntityRecord(r as unknown as Record<string, unknown>, r.name));
      } else {
        const page = await withTenantTx(async (tx) => tx
          .select()
          .from(schema.pipeline)
          .where(and(
            eq(schema.pipeline.isActive, true),
            eq(schema.pipeline.orgId, orgId),
            ...(cursor === undefined ? [] : [gt(schema.pipeline.id, cursor)]),
          ))
          .orderBy(asc(schema.pipeline.id))
          .limit(pageSize));
        rows = page.map((r: typeof schema.pipeline.$inferSelect) => toEntityRecord(r as unknown as Record<string, unknown>, r.pipelineName));
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
