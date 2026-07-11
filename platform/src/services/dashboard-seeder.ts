// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull } from 'drizzle-orm';

import auditActivity from '../observability/dashboards/audit-activity.json' with { type: 'json' };
import platformOverview from '../observability/dashboards/platform-overview.json' with { type: 'json' };
import pluginBuilds from '../observability/dashboards/plugin-builds.json' with { type: 'json' };
import queueHealth from '../observability/dashboards/queue-health.json' with { type: 'json' };
import registryActivity from '../observability/dashboards/registry-activity.json' with { type: 'json' };

const logger = createLogger('dashboard-seeder');

/**
 * The default observability dashboards, loaded from the canonical JSON files
 * in `src/observability/dashboards/*.json`. They become `visibility=public,
 * org_id='system'` rows so the system-org visibility rule covers every
 * authenticated org by default; the frontend's dynamic dashboard renderer
 * picks them up via `GET /api/dashboards`.
 *
 * This in-process seeder is the sole loader: it runs on every platform cold
 * start, writes org_id='system' rows directly to the DB (no auth, no HTTP),
 * and is the single source of truth. Editing a default dashboard means
 * editing its JSON — there's no parallel hand-maintained array to drift from
 * (that drift is exactly what previously broke a renamed query key).
 *
 * The JSON is bundled into `lib/` at compile time (tsc copies imported JSON
 * under rootDir to outDir) and ships in the Docker image via the existing
 * `COPY .docker-build/lib/` step.
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

// The JSON modules carry an extra `visibility` field this seeder doesn't read
// (it always writes 'public'); cast through unknown so that field plus tsc's
// wide literal inference for the panel arrays don't fight the SeedDashboard
// shape.
const DEFAULT_DASHBOARDS: SeedDashboard[] = [
  platformOverview,
  pluginBuilds,
  queueHealth,
  registryActivity,
  auditActivity,
] as unknown as SeedDashboard[];

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
            eq(schema.dashboard.orgId, SYSTEM_ORG_ID),
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
            orgId: SYSTEM_ORG_ID,
            createdBy: SYSTEM_ORG_ID,
            updatedBy: SYSTEM_ORG_ID,
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
