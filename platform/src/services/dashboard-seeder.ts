// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-core';
import { and, eq, isNull } from 'drizzle-orm';

const logger = createLogger('dashboard-seeder');

/**
 * Embedded copy of the 5 static dashboards previously declared in
 * `frontend/src/lib/dashboards/*.ts`. They become `visibility=public,
 * org_id='system'` rows so the system-org visibility rule covers every
 * authenticated org by default; the frontend's dynamic dashboard renderer
 * (PR-E2) picks them up via `GET /api/dashboards`.
 *
 * PR-E4 will externalize this into JSON under `deploy/<target>/seeds/dashboards/`
 * + a `load-dashboards.sh` script; this in-process seeder is the bootstrap
 * path that runs every cold start to keep the defaults in sync without a
 * separate deploy step.
 *
 * Re-seed semantics: insert-if-missing keyed by `(org_id='system', name)`.
 * Operators who edit a public dashboard get their changes preserved across
 * platform restarts because the seeder only touches rows it created.
 */

interface SeedPanel {
  queryKey: string;
  vizKind: 'stat' | 'line' | 'table' | 'stacked-bar';
  title: string;
  span: number;
  groupBy?: string;
  format?: 'percent' | 'seconds';
  vars?: Record<string, string>;
}

interface SeedDashboard {
  name: string;
  description: string;
  panels: SeedPanel[];
}

const DEFAULT_DASHBOARDS: SeedDashboard[] = [
  {
    name: 'Platform Overview',
    description: 'Org/user counts and login activity, plus build + queue health at a glance.',
    panels: [
      { queryKey: 'platform_orgs_total', vizKind: 'stat', title: 'Organizations', span: 3 },
      { queryKey: 'platform_users_total', vizKind: 'stat', title: 'Users', span: 3 },
      { queryKey: 'platform_memberships_active_total', vizKind: 'stat', title: 'Active memberships', span: 3 },
      { queryKey: 'platform_logins_24h', vizKind: 'stat', title: 'Logins (24h)', span: 3 },
      { queryKey: 'platform_logins_per_min', vizKind: 'line', title: 'Logins per minute', span: 6 },
      { queryKey: 'plugin_builds_per_min', vizKind: 'line', title: 'Plugin builds per minute', span: 6, groupBy: 'status' },
      { queryKey: 'plugin_build_success_rate_5m', vizKind: 'line', title: 'Build success rate (5m)', span: 6, format: 'percent' },
      { queryKey: 'plugin_queue_depth', vizKind: 'line', title: 'Build queue depth', span: 6, groupBy: 'state' },
    ],
  },
  {
    name: 'Plugin Builds',
    description: 'Build throughput, success rate, duration, and BullMQ queue depth.',
    panels: [
      { queryKey: 'plugin_builds_total_24h', vizKind: 'stat', title: 'Total builds (24h)', span: 3 },
      { queryKey: 'plugin_build_p95_duration_sec', vizKind: 'line', title: 'p95 duration (5m)', span: 9, format: 'seconds' },
      { queryKey: 'plugin_builds_per_min', vizKind: 'line', title: 'Builds per minute', span: 6, groupBy: 'status' },
      { queryKey: 'plugin_build_success_rate_5m', vizKind: 'line', title: 'Success rate (5m)', span: 6, format: 'percent' },
      { queryKey: 'plugin_queue_depth', vizKind: 'line', title: 'Queue depth', span: 12, groupBy: 'state' },
    ],
  },
  {
    name: 'Queue Health',
    description: 'Wait-time percentiles, DLQ depth, retry rate — for diagnosing congestion.',
    panels: [
      { queryKey: 'plugin_job_wait_p50', vizKind: 'line', title: 'p50 wait', span: 4, format: 'seconds' },
      { queryKey: 'plugin_job_wait_p95', vizKind: 'line', title: 'p95 wait', span: 4, format: 'seconds' },
      { queryKey: 'plugin_job_wait_p99', vizKind: 'line', title: 'p99 wait', span: 4, format: 'seconds' },
      { queryKey: 'plugin_dlq_size', vizKind: 'line', title: 'DLQ depth', span: 6, groupBy: 'state' },
      { queryKey: 'plugin_retry_rate', vizKind: 'line', title: 'Retry rate', span: 6 },
    ],
  },
  {
    name: 'Registry Activity',
    description: 'Copy / delete / promote counters over the in-cluster Docker registry.',
    panels: [
      { queryKey: 'registry_copies_24h', vizKind: 'stat', title: 'Copies (24h)', span: 4 },
      { queryKey: 'registry_deletes_24h', vizKind: 'stat', title: 'Deletes (24h)', span: 4 },
      { queryKey: 'registry_promotions_24h', vizKind: 'stat', title: 'Promotions (24h)', span: 4 },
      { queryKey: 'registry_copies_per_min', vizKind: 'line', title: 'Copies per minute', span: 4 },
      { queryKey: 'registry_deletes_per_min', vizKind: 'line', title: 'Deletes per minute', span: 4 },
      { queryKey: 'registry_promotions_per_hour', vizKind: 'line', title: 'Promotions per hour', span: 4 },
    ],
  },
  {
    name: 'Audit Activity',
    description: 'Audit events over time, top actors, and a searchable recent-events table.',
    panels: [
      { queryKey: 'audit_events_per_hour_by_event', vizKind: 'stacked-bar', title: 'Events per hour by type', span: 8 },
      { queryKey: 'audit_top_actors_24h', vizKind: 'table', title: 'Top actors (24h)', span: 4 },
      { queryKey: 'audit_recent_events', vizKind: 'table', title: 'Recent events', span: 12 },
    ],
  },
];

/**
 * Insert any missing default dashboard. Skips dashboards that already exist
 * for `(org_id='system', name=X)` so operator edits + repeated cold starts
 * don't clobber state. Per dashboard, runs in a transaction so a half-inserted
 * dashboard never appears in the DB.
 */
export async function seedDefaultDashboards(): Promise<void> {
  // Seeder runs as sysadmin: it writes orgId='system' rows that no per-org
  // RLS context could see, and there's no request scope at cold-start anyway.
  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    for (const def of DEFAULT_DASHBOARDS) {
      try {
        const existing = await withTenantTx(async (tx) => tx
          .select({ id: schema.dashboard.id })
          .from(schema.dashboard)
          .where(and(
            eq(schema.dashboard.orgId, 'system'),
            eq(schema.dashboard.name, def.name),
            isNull(schema.dashboard.deletedAt),
          ))
          .limit(1));

        if (existing.length > 0) {
          logger.debug('Default dashboard already present, skipping', { name: def.name });
          continue;
        }

        await withTenantTx(async (tx) => {
          const [created] = await tx.insert(schema.dashboard).values({
            orgId: 'system',
            createdBy: 'system',
            updatedBy: 'system',
            name: def.name,
            description: def.description,
            visibility: 'public',
            layoutJson: {},
          }).returning();

          await tx.insert(schema.dashboardPanel).values(
            def.panels.map((p, i) => ({
              dashboardId: created.id,
              queryKey: p.queryKey,
              vizKind: p.vizKind,
              title: p.title,
              span: p.span,
              groupBy: p.groupBy ?? null,
              format: p.format ?? null,
              position: i,
              vars: p.vars ?? {},
            })),
          );
          logger.info('Seeded default dashboard', { name: def.name, panels: def.panels.length });
        });
      } catch (err) {
        // Postgres may not be reachable yet at platform cold start. Don't
        // crash the service — the seeder runs again on the next restart.
        logger.warn('Failed to seed default dashboard (will retry on next start)', {
          name: def.name,
          error: errorMessage(err),
        });
      }
    }
  });
}
