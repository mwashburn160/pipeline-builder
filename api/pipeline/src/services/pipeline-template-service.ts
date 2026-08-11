// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CrudService, buildPipelineTemplateConditions, schema, withTenantTx, type PipelineTemplateFilter } from '@pipeline-builder/pipeline-data';
import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

export type PipelineTemplate = typeof schema.pipelineTemplate.$inferSelect;
export type PipelineTemplateInsert = typeof schema.pipelineTemplate.$inferInsert;
export type PipelineTemplateUpdate = Partial<Omit<PipelineTemplate, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Pipeline-template CRUD service (golden-path catalog). Templates have no
 * project scope, so `getProjectColumn` is null; visibility is org-own +
 * system-org public (shared golden paths), handled by
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

  protected buildConditions(filter: Partial<PipelineTemplateFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    return buildPipelineTemplateConditions(filter, orgId, parentOrgId);
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
   * Create — overrides the base upsert so a `(name, orgId)` conflict does NOT
   * reassign ownership or rewrite provenance. The base `create` spreads the full
   * insert `data` (including `ownerId`/`createdBy`) into the ON CONFLICT set, so
   * a racing re-create with the same name would silently re-home the template to
   * whoever re-ran it. Here the conflict set writes only mutable columns; owner
   * and provenance are preserved. (The route also does a friendly 409 pre-check;
   * this is the durable, race-proof guarantee.)
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
        set: { ...mutable, updatedAt: new Date(), updatedBy: user } as any,
      })
      .returning());
    return rows[0] as unknown as PipelineTemplate;
  }
}

export const pipelineTemplateService = new PipelineTemplateService();
