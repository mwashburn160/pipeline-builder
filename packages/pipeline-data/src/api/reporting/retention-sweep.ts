// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reporting retention SWEEP: the batched hard-delete that enforces the
 * windows `./retention.ts` resolves. Split from the windows module so the pure,
 * env-only policy stays free of database code, and from the reporting service
 * because this is cross-tenant housekeeping, not a report.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { resolveEventRetentionDays, resolveDoraRetentionDays, retentionCutoff } from './retention.js';
import type { ReportingRetentionCounts, ReportingRetentionOptions } from './types.js';
import { schema } from '../../database/drizzle-schema.js';
import { withTenantTx, runWithTenantContext } from '../../database/tenancy.js';
import { drizzleRows } from '../crud-service.js';

const logger = createLogger('reporting-retention');

/**
 * Batched hard-DELETE of one reporting table's rows expired past a `created_at`
 * cutoff, scoped to an org and an optional row predicate. Uses a
 * `ctid`-in-subquery LIMIT so each statement touches at most `batchSize` rows
 * (short lock windows, no long table scan under lock); `RETURNING 1` lets us
 * count via `.rows.length` without depending on the driver's `rowCount`. Loops
 * until a short batch (drained) or the per-tick cap, then defers the rest.
 * MUST run inside a sysadmin tenant scope (see purgeExpiredReportingData) so it
 * bypasses RLS and can delete across the org's rows.
 */
async function purgeReportingTableBatched(
  tableSql: ReturnType<typeof sql>,
  predicate: ReturnType<typeof sql>,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = await withTenantTx((tx) => tx.execute(sql`
      DELETE FROM ${tableSql}
      WHERE ctid IN (
        SELECT ctid FROM ${tableSql}
        WHERE ${predicate}
        LIMIT ${batchSize}
      )
      RETURNING 1
    `));
    const purged = drizzleRows<unknown>(res.rows).length;
    total += purged;
    if (purged < batchSize) break; // drained
    if (i === maxBatches - 1) {
      logger.warn('Reporting retention hit per-tick cap; remaining rows deferred', {
        purgedThisTick: total,
      });
    }
  }
  return total;
}

/**
 * Reporting retention sweep. Hard-deletes rows older than their
 * retention window, by `created_at`, across every org that has reporting data —
 * a **split** policy so high-volume standard events expire faster than the
 * low-volume DORA source:
 *  - `pipeline_events WHERE environment IS NULL` → standard-event window.
 *  - `pipeline_events WHERE environment IS NOT NULL` (deploy stages),
 *    `deployment_outcomes`, and `incidents` → DORA-source window.
 * Each org's windows come from its `dora_settings` override, else the global
 * env defaults (see {@link resolveEventRetentionDays} / {@link resolveDoraRetentionDays}).
 * `ingest_health` and `dora_settings` are never purged. One `now` for the whole
 * tick (rows crossing the boundary mid-sweep wait for the next). Establishes a
 * sysadmin tenant scope so the deletes span all orgs / bypass RLS — this is a
 * cross-tenant housekeeping job. Returns (and logs) per-window purge tallies.
 */
export async function purgeExpiredReportingData(opts: ReportingRetentionOptions = {}): Promise<ReportingRetentionCounts> {
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  const maxBatches = Math.max(1, opts.maxBatchesPerTable ?? 50);
  const now = opts.now ?? new Date();
  const resolveRetentionOrgId = opts.resolveRetentionOrgId ?? (async (orgId: string) => orgId);
  const counts: ReportingRetentionCounts = {
    orgs: 0, standardEvents: 0, doraEvents: 0, deploymentOutcomes: 0, incidents: 0,
  };

  return runWithTenantContext({ isSuperAdmin: true }, async () => {
    // Enumerate every org with reporting data (union across the three tables).
    const orgRows = drizzleRows<{ org_id: string }>((await withTenantTx((tx) => tx.execute(sql`
      SELECT DISTINCT org_id FROM (
        SELECT ${schema.pipelineEvent.orgId} AS org_id FROM ${schema.pipelineEvent}
        UNION
        SELECT ${schema.deploymentOutcome.orgId} AS org_id FROM ${schema.deploymentOutcome}
        UNION
        SELECT ${schema.incident.orgId} AS org_id FROM ${schema.incident}
      ) AS orgs
    `))).rows);
    if (orgRows.length === 0) return counts;

    // Per-org retention overrides (a single read; orgs without a row use defaults).
    const overrideRows = drizzleRows<{
      org_id: string;
      event_retention_days: number | null;
      dora_retention_days: number | null;
    }>((await withTenantTx((tx) => tx.execute(sql`
      SELECT ${schema.doraSettings.orgId} AS org_id,
             ${schema.doraSettings.eventRetentionDays} AS event_retention_days,
             ${schema.doraSettings.doraRetentionDays} AS dora_retention_days
      FROM ${schema.doraSettings}
    `))).rows);
    const overrides = new Map(overrideRows.map((r) => [r.org_id, r]));

    const eventsTable = sql`${schema.pipelineEvent}`;
    const outcomesTable = sql`${schema.deploymentOutcome}`;
    const incidentsTable = sql`${schema.incident}`;

    for (const { org_id: orgId } of orgRows) {
      // Retention follows the account ROOT's entitlement (billing syncs it onto
      // the root only). An unresolvable root ⇒ skip this org this tick rather
      // than purge a team's rows on the (shorter) env default.
      let retentionOrgId: string | null;
      try {
        retentionOrgId = await resolveRetentionOrgId(orgId);
      } catch (err) {
        logger.warn('Reporting retention: root resolution threw; skipping org this tick', { orgId, error: errorMessage(err) });
        retentionOrgId = null;
      }
      if (retentionOrgId === null) {
        logger.warn('Reporting retention: could not resolve the retention root; org skipped this tick', { orgId });
        continue;
      }
      const ov = overrides.get(retentionOrgId);
      const eventDays = resolveEventRetentionDays(ov?.event_retention_days);
      const doraDays = resolveDoraRetentionDays(ov?.dora_retention_days);
      // `-1` = unlimited: keep forever, skip that window's deletes for
      // this org. Standard-event and DORA-source windows are independent; an org
      // with both `-1` is fully skipped. Log the skip so it's observable.
      const skipEvents = eventDays === -1;
      const skipDora = doraDays === -1;
      if (skipEvents || skipDora) {
        logger.info('Reporting retention sweep skipping unlimited window(s)', {
          orgId,
          standardEvents: skipEvents ? 'unlimited' : eventDays,
          doraSource: skipDora ? 'unlimited' : doraDays,
        });
      }

      if (!skipEvents) {
        const eventCutoff = retentionCutoff(now, eventDays);
        counts.standardEvents += await purgeReportingTableBatched(
          eventsTable,
          // Spare rows carrying a commit timestamp: they are DORA SOURCE data.
          // Lead time joins deploys to the execution's earliest
          // `commit_timestamp`, and that enrichment rides the PIPELINE/source
          // event (environment IS NULL), never the deploy STAGE row. Purging
          // them on this short window while the deploys they explain live on
          // the DORA window made lead time read "unknown" for every range
          // older than the standard retention — silently, with the deploys
          // still counted. They follow the DORA window below instead.
          sql`org_id = ${orgId} AND environment IS NULL AND commit_timestamp IS NULL AND created_at < ${eventCutoff}`,
          batchSize, maxBatches,
        );
      }

      if (!skipDora) {
        const doraCutoff = retentionCutoff(now, doraDays);
        counts.doraEvents += await purgeReportingTableBatched(
          eventsTable,
          sql`org_id = ${orgId} AND (environment IS NOT NULL OR commit_timestamp IS NOT NULL) AND created_at < ${doraCutoff}`,
          batchSize, maxBatches,
        );
        counts.deploymentOutcomes += await purgeReportingTableBatched(
          outcomesTable,
          sql`org_id = ${orgId} AND created_at < ${doraCutoff}`,
          batchSize, maxBatches,
        );
        counts.incidents += await purgeReportingTableBatched(
          incidentsTable,
          sql`org_id = ${orgId} AND created_at < ${doraCutoff}`,
          batchSize, maxBatches,
        );
      }
      counts.orgs += 1;
    }

    const purgedAny = counts.standardEvents + counts.doraEvents + counts.deploymentOutcomes + counts.incidents;
    if (purgedAny > 0) logger.info('Reporting retention sweep purged expired rows', { ...counts });
    return counts;
  });
}
