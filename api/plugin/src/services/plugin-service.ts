// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { entityEvents, createCacheService, createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { CoreConstants, AccessModifier, ComputeType, PluginType } from '@pipeline-builder/pipeline-core';
import { CrudService, buildPluginConditions, getTenantContext, schema, withTenantTx, type PluginFilter } from '@pipeline-builder/pipeline-data';
import { and, eq, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

const logger = createLogger('plugin-service');

/** Server-side cache for plugin reads. */
const pluginCache = createCacheService('plugin:', CoreConstants.CACHE_TTL_ENTITY);

export type Plugin = typeof schema.plugin.$inferSelect;
export type PluginInsert = typeof schema.plugin.$inferInsert;
export type PluginUpdate = Partial<Omit<Plugin, 'id' | 'createdAt' | 'createdBy'>>;

/** Plugin CRUD service with multi-tenant access control. */
export class PluginService extends CrudService<
  Plugin,
  PluginFilter,
  PluginInsert,
  PluginUpdate
> {
  protected get schema(): PgTable {
    return schema.plugin as PgTable;
  }

  protected buildConditions(filter: Partial<PluginFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    return buildPluginConditions(filter, orgId, parentOrgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const sortableColumns: Record<string, AnyColumn> = {
      id: schema.plugin.id,
      name: schema.plugin.name,
      version: schema.plugin.version,
      createdAt: schema.plugin.createdAt,
      updatedAt: schema.plugin.updatedAt,
      isActive: schema.plugin.isActive,
      isDefault: schema.plugin.isDefault,
    };

    return sortableColumns[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return null; // Plugins are org-scoped, not project-scoped
  }

  protected getOrgColumn(): AnyColumn {
    return schema.plugin.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.plugin.name, schema.plugin.version, schema.plugin.orgId];
  }

  // -- Cached reads -----------------------------------------------------------

  /** findById with server-side cache (keyed by orgId[:p:parentOrgId]:id). The
   *  parent segment keeps a team's parent-widened read from colliding with the
   *  own-org-only read under the same orgId. */
  async findById(id: string, orgId?: string, parentOrgId?: string): Promise<Plugin | null> {
    const cacheKey = `${orgId || 'anon'}${parentOrgId ? `:p:${parentOrgId}` : ''}:id:${id}`;
    return pluginCache.getOrSet(cacheKey, () => super.findById(id, orgId, parentOrgId));
  }

  // -- Lifecycle hooks — emit events + invalidate cache ---------------------

  private async invalidateAndEmit(eventType: 'created' | 'updated' | 'deleted', id: string, entity: Plugin, userId: string): Promise<void> {
    try {
      await pluginCache.invalidatePattern(`${entity.orgId}:*`);
      // System-org content is visible to every tenant via the dashboard;
      // when a system entity changes, evict the per-id cache key across
      // every cached org so no tenant serves a stale copy.
      if (entity.orgId === SYSTEM_ORG_ID) {
        await pluginCache.invalidatePattern(`*:id:${entity.id}`);
      }
    } catch (err) {
      logger.debug(`Cache invalidation failed after plugin ${eventType}`, { orgId: entity.orgId, error: errorMessage(err) });
    }
    // Carry the owning org's parent (when the mutation ran under a team's tenant
    // context) so async compliance eval sees the same parent `propagateToChildren`
    // rules the live path does. Only trust the context parent when its org matches
    // the entity's — a cross-org mutation must not inherit the caller's parent.
    const tenant = getTenantContext();
    const parentOrgId = tenant?.orgId === entity.orgId ? tenant?.parentOrgId : undefined;
    entityEvents.emit({ eventType, target: 'plugin', entityId: id, orgId: entity.orgId, parentOrgId, userId, timestamp: new Date(), attributes: entity });
  }

  protected async onAfterCreate(entity: Plugin, userId: string): Promise<void> {
    await this.invalidateAndEmit('created', entity.id, entity, userId);
  }

  protected async onAfterUpdate(id: string, entity: Plugin, userId: string): Promise<void> {
    await this.invalidateAndEmit('updated', id, entity, userId);
  }

  protected async onAfterDelete(id: string, entity: Plugin, userId: string): Promise<void> {
    await this.invalidateAndEmit('deleted', id, entity, userId);
  }

  /** Atomically deploy a new plugin version as default (clears old defaults for same name+org). */
  async deployVersion(
    data: PluginInsert,
    userId: string,
  ): Promise<Plugin> {
    return withTenantTx(async (tx) => {
      // Lock existing defaults by name+org to prevent concurrent races
      await tx.execute(
        sql`SELECT id FROM ${schema.plugin}
            WHERE ${schema.plugin.name} = ${data.name}
              AND ${schema.plugin.orgId} = ${data.orgId}
              AND ${schema.plugin.isDefault} = true
            FOR UPDATE`,
      );

      // Unset the CURRENT default for this plugin name in the org. Scope to
      // `isDefault = true` (mirrors pipeline-service) so we don't stamp
      // updatedAt/updatedBy on every non-default version and churn their
      // recently-updated ordering + cache keys.
      await tx
        .update(schema.plugin)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(
          and(
            eq(schema.plugin.name, data.name),
            eq(schema.plugin.orgId, data.orgId!),
            eq(schema.plugin.isDefault, true),
          ),
        );

      // Upsert the new version as default
      const [upserted] = await tx
        .insert(schema.plugin)
        .values({
          ...data,
          pluginType: data.pluginType as PluginType,
          computeType: data.computeType as ComputeType,
          accessModifier: data.accessModifier as AccessModifier,
          isDefault: true,
          isActive: true,
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target: [schema.plugin.name, schema.plugin.version, schema.plugin.orgId],
          set: {
            description: data.description,
            ...((data as Record<string, unknown>).category !== undefined
              ? { category: (data as Record<string, unknown>).category as string } : {}),
            keywords: data.keywords,
            metadata: data.metadata,
            pluginType: data.pluginType as PluginType,
            computeType: data.computeType as ComputeType,
            timeout: data.timeout,
            failureBehavior: data.failureBehavior,
            secrets: data.secrets,
            primaryOutputDirectory: data.primaryOutputDirectory,
            env: data.env,
            buildArgs: data.buildArgs,
            installCommands: data.installCommands,
            commands: data.commands,
            dockerfile: data.dockerfile,
            accessModifier: data.accessModifier as AccessModifier,
            isDefault: true,
            isActive: true,
            deletedAt: null,
            deletedBy: null,
            updatedBy: userId,
            updatedAt: new Date(),
          },
        })
        .returning();

      const result = upserted as Plugin;
      pluginCache.invalidatePattern(`${data.orgId}:*`).catch((err) => {
        logger.debug('Cache invalidation failed after plugin deploy', { orgId: data.orgId, error: errorMessage(err) });
      });
      return result;
    });
  }
}

export const pluginService = new PluginService();
