// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { db, schema } from '@pipeline-builder/pipeline-core';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

const logger = createLogger('DashboardService');

type Dashboard = typeof schema.dashboard.$inferSelect;
type DashboardInsert = typeof schema.dashboard.$inferInsert;
type DashboardPanel = typeof schema.dashboardPanel.$inferSelect;
type DashboardPanelInsert = typeof schema.dashboardPanel.$inferInsert;

/** A dashboard returned to the API includes its panels in render order. */
export interface DashboardWithPanels extends Dashboard {
  panels: DashboardPanel[];
}

export interface PanelInput {
  /** Catalog query key (e.g. `plugin_builds_per_min`). Validated server-side. */
  queryKey: string;
  vizKind?: string;
  title: string;
  span?: number;
  groupBy?: string | null;
  format?: string | null;
  position?: number;
  vars?: Record<string, string>;
}

export interface DashboardCreate {
  name: string;
  description?: string;
  visibility?: 'private' | 'org' | 'public';
  layoutJson?: Record<string, { x: number; y: number; w: number; h: number; minW?: number; minH?: number }>;
  panels: PanelInput[];
}

export interface DashboardUpdate {
  name?: string;
  description?: string | null;
  visibility?: 'private' | 'org' | 'public';
  layoutJson?: Record<string, { x: number; y: number; w: number; h: number; minW?: number; minH?: number }>;
  /** When supplied, replaces the panel set atomically (full-set update). */
  panels?: PanelInput[];
}

/**
 * Dashboards CRUD service.
 *
 * Reads are visibility-filtered at the SQL layer:
 *  - `public` rows are visible to everyone
 *  - `org` rows are visible to same-org callers
 *  - `private` rows are visible only to the creator
 *
 * Writes enforce ownership / org-admin / sysadmin in the controller layer
 * because the answer depends on the request's role claims, which the service
 * doesn't see.
 */
export class DashboardService {
  /** List dashboards visible to a caller. Sysadmins see everything. */
  async list(opts: { orgId: string; userId: string; isSysAdmin: boolean }): Promise<Dashboard[]> {
    const { orgId, userId, isSysAdmin } = opts;
    const baseWhere = isNull(schema.dashboard.deletedAt);
    if (isSysAdmin) {
      return db.select().from(schema.dashboard).where(baseWhere).orderBy(asc(schema.dashboard.name));
    }
    // Non-sysadmin visibility tree:
    //   public OR (org AND same-org) OR (private AND created_by = me)
    const visibilityWhere = or(
      eq(schema.dashboard.visibility, 'public'),
      and(eq(schema.dashboard.visibility, 'org'), eq(schema.dashboard.orgId, orgId)),
      and(eq(schema.dashboard.visibility, 'private'), eq(schema.dashboard.createdBy, userId)),
    );
    return db
      .select()
      .from(schema.dashboard)
      .where(and(baseWhere, visibilityWhere))
      .orderBy(asc(schema.dashboard.name));
  }

  /** Fetch a single dashboard + its panels in render order. */
  async findById(id: string): Promise<DashboardWithPanels | null> {
    const rows = await db
      .select()
      .from(schema.dashboard)
      .where(and(eq(schema.dashboard.id, id), isNull(schema.dashboard.deletedAt)))
      .limit(1);
    if (rows.length === 0) return null;
    const panels = await db
      .select()
      .from(schema.dashboardPanel)
      .where(eq(schema.dashboardPanel.dashboardId, id))
      .orderBy(asc(schema.dashboardPanel.position));
    return { ...rows[0], panels };
  }

  /**
   * Decide whether `caller` can read the given dashboard. Centralized here so
   * the read-by-id controller doesn't have to duplicate the visibility ladder.
   */
  canRead(dashboard: Dashboard, caller: { orgId: string; userId: string; isSysAdmin: boolean }): boolean {
    if (caller.isSysAdmin) return true;
    if (dashboard.visibility === 'public') return true;
    if (dashboard.visibility === 'org') return dashboard.orgId === caller.orgId;
    return dashboard.createdBy === caller.userId;
  }

  /**
   * Decide whether `caller` can write to the given dashboard.
   * - sysadmin: always
   * - public dashboards: sysadmin only (defends shared defaults)
   * - org dashboards: same-org admins or the creator
   * - private dashboards: only the creator
   */
  canWrite(
    dashboard: Dashboard,
    caller: { orgId: string; userId: string; isSysAdmin: boolean; isOrgAdmin: boolean },
  ): boolean {
    if (caller.isSysAdmin) return true;
    if (dashboard.visibility === 'public') return false;
    if (dashboard.createdBy === caller.userId) return true;
    if (dashboard.visibility === 'org' && caller.isOrgAdmin && dashboard.orgId === caller.orgId) return true;
    return false;
  }

  /** Create a dashboard + its panel set in a single transaction. */
  async create(
    input: DashboardCreate,
    caller: { orgId: string; userId: string },
  ): Promise<DashboardWithPanels> {
    return db.transaction(async (tx) => {
      const visibility = input.visibility ?? 'private';
      const insertRow: DashboardInsert = {
        orgId: caller.orgId,
        createdBy: caller.userId,
        updatedBy: caller.userId,
        name: input.name,
        description: input.description ?? null,
        layoutJson: input.layoutJson ?? {},
        visibility,
      };
      const [created] = await tx.insert(schema.dashboard).values(insertRow).returning();
      const panels = await this.insertPanels(tx, created.id, input.panels);
      logger.info('Dashboard created', { id: created.id, orgId: caller.orgId, panels: panels.length });
      return { ...created, panels };
    });
  }

  /**
   * Update dashboard metadata and optionally replace its panel set atomically.
   * Returns the refreshed dashboard with panels in render order.
   */
  async update(
    id: string,
    input: DashboardUpdate,
    caller: { userId: string },
  ): Promise<DashboardWithPanels | null> {
    return db.transaction(async (tx) => {
      const updates: Partial<DashboardInsert> = { updatedBy: caller.userId };
      if (input.name !== undefined) updates.name = input.name;
      if (input.description !== undefined) updates.description = input.description;
      if (input.visibility !== undefined) updates.visibility = input.visibility;
      if (input.layoutJson !== undefined) updates.layoutJson = input.layoutJson;

      const [updated] = await tx
        .update(schema.dashboard)
        .set(updates)
        .where(and(eq(schema.dashboard.id, id), isNull(schema.dashboard.deletedAt)))
        .returning();

      if (!updated) return null;

      if (input.panels !== undefined) {
        // Atomic full-set replace: delete then reinsert. Cheaper than diffing
        // because the panel count per dashboard is small (~5-20).
        await tx.delete(schema.dashboardPanel).where(eq(schema.dashboardPanel.dashboardId, id));
        const panels = await this.insertPanels(tx, id, input.panels);
        return { ...updated, panels };
      }

      // Panels untouched — fetch them in render order for the response.
      const panels = await tx
        .select()
        .from(schema.dashboardPanel)
        .where(eq(schema.dashboardPanel.dashboardId, id))
        .orderBy(asc(schema.dashboardPanel.position));
      return { ...updated, panels };
    });
  }

  /** Soft delete (mark deletedAt + deletedBy). */
  async delete(id: string, caller: { userId: string }): Promise<boolean> {
    const [deleted] = await db
      .update(schema.dashboard)
      .set({ deletedAt: sql`CURRENT_TIMESTAMP`, deletedBy: caller.userId })
      .where(and(eq(schema.dashboard.id, id), isNull(schema.dashboard.deletedAt)))
      .returning({ id: schema.dashboard.id });
    return !!deleted;
  }

  /**
   * Clone a dashboard into the caller's org. The clone defaults to private
   * visibility and an unsuffixed copy of the source name; if the name collides
   * with another dashboard in the caller's org, we append " (copy)" once and
   * fall back to ` (copy N)` for further conflicts.
   */
  async clone(sourceId: string, caller: { orgId: string; userId: string }): Promise<DashboardWithPanels | null> {
    const source = await this.findById(sourceId);
    if (!source) return null;
    const name = await this.uniqueNameInOrg(source.name, caller.orgId);
    return this.create(
      {
        name,
        description: source.description ?? undefined,
        visibility: 'private',
        layoutJson: source.layoutJson,
        panels: source.panels.map(p => ({
          queryKey: p.queryKey,
          vizKind: p.vizKind,
          title: p.title,
          span: p.span,
          groupBy: p.groupBy,
          format: p.format,
          position: p.position,
          vars: p.vars,
        })),
      },
      caller,
    );
  }

  /** Suffix the name with " (copy)" / " (copy N)" until it's unique in the org. */
  private async uniqueNameInOrg(name: string, orgId: string): Promise<string> {
    // Strip an existing " (copy ...)" suffix so we don't pile up "(copy) (copy)".
    const base = name.replace(/\s*\(copy(\s+\d+)?\)\s*$/, '').trim();
    const candidates = [base, `${base} (copy)`];
    for (let i = 2; i <= 20; i++) candidates.push(`${base} (copy ${i})`);
    for (const candidate of candidates) {
      const rows = await db
        .select({ id: schema.dashboard.id })
        .from(schema.dashboard)
        .where(and(
          eq(schema.dashboard.orgId, orgId),
          eq(schema.dashboard.name, candidate),
          isNull(schema.dashboard.deletedAt),
        ))
        .limit(1);
      if (rows.length === 0) return candidate;
    }
    // 20+ copies of the same base name in the same org — fall back to a
    // timestamp suffix rather than failing the request.
    return `${base} (copy ${Date.now()})`;
  }

  /**
   * Insert a fresh panel set for a dashboard. The transactional caller
   * already deleted any existing panels (or the dashboard was just created
   * with no panels), so this is an unconditional INSERT.
   */
  private async insertPanels(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    dashboardId: string,
    panels: PanelInput[],
  ): Promise<DashboardPanel[]> {
    if (panels.length === 0) return [];
    const rows: DashboardPanelInsert[] = panels.map((p, i) => ({
      dashboardId,
      queryKey: p.queryKey,
      vizKind: p.vizKind ?? 'line',
      title: p.title,
      span: p.span ?? 6,
      groupBy: p.groupBy ?? null,
      format: p.format ?? null,
      // Honor explicit position if the client supplied one, otherwise fall
      // back to the array index (editor saves drag order this way).
      position: p.position ?? i,
      vars: p.vars ?? {},
    }));
    return tx.insert(schema.dashboardPanel).values(rows).returning();
  }
}

export const dashboardService = new DashboardService();
