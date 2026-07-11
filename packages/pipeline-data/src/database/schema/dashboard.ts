// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * User-editable observability dashboard. Replaces the code-defined dashboards
 * under `frontend/src/lib/dashboards/*.ts` so operators can add panels and
 * customize layout per-org without a redeploy.
 *
 * `layoutJson` carries the react-grid-layout coordinate set keyed by panel id;
 * `dashboard_panels` holds the panel-content rows so an N-panel dashboard
 * doesn't bloat one row's JSON to several KB. The catalog query is referenced
 * by key only (see platform/src/observability/catalog.ts)  the dashboard
 * record never carries raw PromQL/LogQL, keeping the catalog as the security
 * boundary for upstream query execution.
 *
 * Visibility ladder * - `private`  only the creator can read/write
 * - `org`  anyone in the same org can read; org admins + creator can write
 * - `public`  every authenticated user can read; only sysadmins can write.
 * Used for the 5 default dashboards (`org_id='system'`) so the
 * existing system-org visibility rule covers them by default.
 *
 * @table dashboards
 */
export const dashboard = pgTable('dashboards', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Org + creator
  orgId: varchar('org_id', { length: 255 })
    .default(SYSTEM_ORG_ID)
    .notNull(),
  createdBy: text('created_by')
    .default(SYSTEM_ORG_ID)
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default(SYSTEM_ORG_ID)
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Identity
  name: varchar('name', { length: 150 })
    .notNull(),
  description: text('description'),

  // react-grid-layout coordinate set keyed by panel id.
  // Shape: { [panelId]: { x, y, w, h, minW?, minH? } }
  layoutJson: jsonb('layout_json')
    .$type<Record<string, { x: number; y: number; w: number; h: number; minW?: number; minH?: number }>>()
    .default({})
    .notNull(),

  // Visibility  see header for ladder semantics. Constrained at the SQL
  // layer too via a CHECK in postgres-init.sql to keep typos from sneaking
  // past the application layer.
  visibility: varchar('visibility', { length: 10 })
    .$type<'private' | 'org' | 'public'>()
    .default('private')
    .notNull(),

  // Soft delete (matches the rest of the schema's convention)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Listing is org-scoped and visibility-filtered, so both go in the index.
  orgVisibilityIdx: index('dashboard_org_visibility_idx').on(table.orgId, table.visibility),
  // Convenience for "all my dashboards" listing
  createdByIdx: index('dashboard_created_by_idx').on(table.createdBy),
  // Same-org duplicate-name guard. The (orgId, name) tuple is unique among
  // non-deleted rows; soft-deleted rows are excluded so name reuse after
  // deletion works.
  nameUnique: uniqueIndex('dashboard_org_name_unique').on(table.orgId, table.name),
}));

/**
 * A single panel inside a dashboard. The catalog `queryKey` is the only thing
 * the panel carries from the query side  substitution + execution happens
 * server-side via the existing catalog, so no PromQL/LogQL travels with the
 * panel record.
 *
 * @table dashboard_panels
 */
export const dashboardPanel = pgTable('dashboard_panels', {
  id: uuid('id').primaryKey().defaultRandom(),
  dashboardId: uuid('dashboard_id')
    .notNull(),
  // Catalog key (e.g. `plugin_builds_per_min`). The server validates this
  // against QUERIES at render time.
  queryKey: varchar('query_key', { length: 100 })
    .notNull(),
  // 'stat' | 'line' | 'table' | 'stacked-bar'  kept stringly-typed for
  // forward compatibility; the renderer falls back to 'line' on unknown.
  vizKind: varchar('viz_kind', { length: 30 })
    .default('line')
    .notNull(),
  title: varchar('title', { length: 200 })
    .notNull(),
  // Tailwind col-span tier (1-12, but only 3/4/6/8/9/12 are renderable).
  span: integer('span')
    .default(6)
    .notNull(),
  // Optional: label key for series grouping (e.g. 'status', 'state').
  groupBy: varchar('group_by', { length: 50 }),
  // Optional: catalog format key ('percent' | 'seconds' |...).
  format: varchar('format', { length: 20 }),
  // 0-based render order within the dashboard. Editor reassigns on drag.
  position: integer('position')
    .default(0)
    .notNull(),
  // Optional template var values bound at panel level (e.g. `plugin=X` for
  // the per-plugin drill-down panel). Sanitized server-side via the catalog
  // substituteVars allow-list.
  vars: jsonb('vars')
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
}, (table) => ({
  // The render path is "fetch all panels for dashboard X in order".
  dashboardPositionIdx: index('dashboard_panel_dashboard_position_idx')
    .on(table.dashboardId, table.position),
}));

// Observability dashboards
export type Dashboard = typeof dashboard.$inferSelect;
export type DashboardInsert = typeof dashboard.$inferInsert;
export type DashboardUpdate = Partial<Omit<DashboardInsert, 'id' | 'createdAt' | 'createdBy'>>;

export type DashboardPanel = typeof dashboardPanel.$inferSelect;
export type DashboardPanelInsert = typeof dashboardPanel.$inferInsert;
export type DashboardPanelUpdate = Partial<Omit<DashboardPanelInsert, 'id'>>;
