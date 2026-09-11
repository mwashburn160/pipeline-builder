// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConflictError } from '@pipeline-builder/api-core';
import { CrudService, buildPipelineTemplateConditions, schema, withTenantTx, withViewerContext, type PipelineTemplateFilter } from '@pipeline-builder/pipeline-data';
import { and, eq, or, sql, SQL } from 'drizzle-orm';
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
    return sortable[sortBy] || null;
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
   * Create — overrides the base upsert so a `(name, orgId)` conflict does NOT
   * reassign ownership or rewrite provenance. The base `create` spreads the full
   * insert `data` (including `ownerId`/`createdBy`) into the ON CONFLICT set, so
   * a racing re-create with the same name would silently re-home the template to
   * whoever re-ran it. Here the conflict set writes only mutable columns; owner
   * and provenance are preserved. (The route also does a friendly 409 pre-check;
   * this is the durable, race-proof guarantee.)
   *
   * Throws `ConflictError` (→ 409) when the conflicting row is a PRIVATE template
   * belonging to someone else: `setWhere` makes the UPDATE branch a no-op there,
   * so a racing same-name create can never overwrite (or resurrect) another
   * author's draft — a hole the route's pre-check alone can't close, and one the
   * per-user `private` rung newly opens.
   */
  async create(data: PipelineTemplateInsert, userId: string): Promise<PipelineTemplate> {
    const user = userId || 'system';
    const safeData = this.enforceOrgId(data) as Record<string, unknown>;
    const { id: _id, createdAt: _createdAt, createdBy: _createdBy, ownerId: _ownerId, ownerType: _ownerType, ...mutable } = safeData;

    const rows = await withTenantTx((tx) => tx
      .insert(schema.pipelineTemplate)
      .values({ ...safeData, createdBy: user, updatedBy: user } as any)
      .onConflictDoUpdate({
        target: [schema.pipelineTemplate.name, schema.pipelineTemplate.orgId],
        // RESURRECT on re-create: delete soft-deletes (isActive=false, deletedAt set),
        // but the (name, orgId) unique index still holds the tombstoned row. Without
        // resetting isActive/deletedAt here, re-creating a same-named template updates
        // its body but leaves it soft-deleted — so it never reappears in the catalog
        // (reads default to isActive=true). Reactivate it so delete→re-create works.
        set: { ...mutable, isActive: true, deletedAt: null, deletedBy: null, updatedAt: new Date(), updatedBy: user } as any,
        // ...but only over a row the caller is entitled to write: a shared
        // (`org`/`public`) template, or a `private` one they authored.
        setWhere: or(
          sql`${schema.pipelineTemplate.visibility} <> 'private'`,
          eq(schema.pipelineTemplate.createdBy, user),
        ),
      })
      .returning());

    const created = rows[0] as unknown as PipelineTemplate | undefined;
    if (!created) {
      throw new ConflictError(`A template named "${String(safeData.name)}" already exists in this organization.`);
    }
    return created;
  }
}

export const pipelineTemplateService = new PipelineTemplateService();
