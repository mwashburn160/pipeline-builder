// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConflictError, SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import { CrudService, buildPipelineTemplateConditions, schema, withTenantTx, withViewerContext, type PipelineTemplateFilter } from '@pipeline-builder/pipeline-data';
import { and, eq, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

export type PipelineTemplate = typeof schema.pipelineTemplate.$inferSelect;
export type PipelineTemplateInsert = typeof schema.pipelineTemplate.$inferInsert;
export type PipelineTemplateUpdate = Partial<Omit<PipelineTemplate, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Pipeline-template CRUD service (golden-path catalog). Templates have no
 * project scope, so `getProjectColumn` is null; reads follow the three-rung
 * `private` / `org` / `public` visibility ladder built by
 * {@link buildPipelineTemplateConditions}.
 */
export class PipelineTemplateService extends CrudService<
  PipelineTemplate,
  PipelineTemplateFilter,
  PipelineTemplateInsert,
  PipelineTemplateUpdate
> {
  protected get schema(): PgTable {
    return schema.pipelineTemplate as PgTable;
  }

  /**
   * Every read and write funnels through here, so this is the ONE place the
   * caller's identity has to be stamped for the per-user `private` rung to
   * resolve — including `CrudService.writeConditions` (update/delete), which
   * builds the read clause from a bare `{ id }` filter and has nowhere to pass a
   * viewer. Without the stamp an author's own private template would fall out of
   * its own UPDATE predicate and 404. See `withViewerContext` for why the tenant
   * context is the right channel and how it fails closed.
   */
  protected buildConditions(filter: Partial<PipelineTemplateFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    return buildPipelineTemplateConditions(withViewerContext(filter), orgId, parentOrgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const sortable: Record<string, AnyColumn> = {
      name: schema.pipelineTemplate.name,
      category: schema.pipelineTemplate.category,
      createdAt: schema.pipelineTemplate.createdAt,
      updatedAt: schema.pipelineTemplate.updatedAt,
      isActive: schema.pipelineTemplate.isActive,
    };
    // Own keys only: `sortBy` is client input, and a plain lookup walks the
    // prototype (`?sortBy=constructor` returned a function, not a column).
    return Object.hasOwn(sortable, sortBy) ? sortable[sortBy] : null;
  }

  /** Templates are not project-scoped. */
  protected getProjectColumn(): AnyColumn | null {
    return null;
  }

  protected getOrgColumn(): AnyColumn {
    return schema.pipelineTemplate.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.pipelineTemplate.name, schema.pipelineTemplate.orgId];
  }

  /**
   * Look up a template by exact name within an org, IGNORING the visibility
   * ladder and the soft-delete state.
   *
   * The `(name, org_id)` unique index is org-wide, so name collisions must be
   * detected org-wide too — a visibility-scoped check would miss a colliding
   * PRIVATE template belonging to another author and let the create path fall
   * through to the ON CONFLICT branch. Returns the row so the route can 409 with
   * an honest message; it exposes only the fact that the name is taken.
   */
  async findByNameInOrg(name: string, orgId: string): Promise<PipelineTemplate | null> {
    const rows = await withTenantTx((tx) => tx
      .select()
      .from(schema.pipelineTemplate)
      .where(and(eq(schema.pipelineTemplate.name, name), eq(schema.pipelineTemplate.orgId, orgId)))
      .limit(1));
    return (rows[0] as unknown as PipelineTemplate) ?? null;
  }

  /**
   * Create — overrides the base upsert: a template create NEVER writes over an
   * existing `(name, org_id)` row. The route 409s any same-name collision up
   * front (org-wide, visibility- and tombstone-blind); this is the race-proof
   * backstop for two concurrent creates that both pass that pre-check.
   *
   * The base `create` (and this method's previous ON CONFLICT DO UPDATE) let the
   * losing racer overwrite the winner's body — which bypassed the visibility
   * ladder for a `public` template (no `templates:publish` check), re-homed
   * ownership, and could resurrect a soft-deleted template without the step-up
   * that `POST /pipeline-templates/:id/restore` requires. `DO NOTHING` +
   * {@link ConflictError} (→ 409) closes all three: editing goes through PUT,
   * reviving through restore.
   */
  async create(data: PipelineTemplateInsert, userId: string): Promise<PipelineTemplate> {
    const user = userId || SYSTEM_ACTOR_ID;
    const safeData = this.enforceOrgId(data) as Record<string, unknown>;

    const rows = await withTenantTx((tx) => tx
      .insert(schema.pipelineTemplate)
      .values({ ...safeData, createdBy: user, updatedBy: user } as any)
      .onConflictDoNothing({ target: [schema.pipelineTemplate.name, schema.pipelineTemplate.orgId] })
      .returning());

    const created = rows[0] as unknown as PipelineTemplate | undefined;
    if (!created) {
      throw new ConflictError(`A template named "${String(safeData.name)}" already exists in this organization.`);
    }
    return created;
  }
}

export const pipelineTemplateService = new PipelineTemplateService();
