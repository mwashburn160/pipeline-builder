import { entityEvents, createCacheService, createLogger, errorMessage } from '@mwashburn160/api-core';
import {
  CoreConstants,
  CrudService,
  buildPluginConditions,
  db,
  schema,
  AccessModifier,
  ComputeType,
  PluginType,
  type PluginFilter,
} from '@mwashburn160/pipeline-core';

const logger = createLogger('plugin-service');

/** Server-side cache for plugin reads. */
const pluginCache = createCacheService('plugin:', CoreConstants.CACHE_TTL_ENTITY);
import { and, eq, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

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

  protected buildConditions(filter: Partial<PluginFilter>, orgId?: string): SQL[] {
    return buildPluginConditions(filter, orgId);
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

  /** findById with server-side cache (keyed by orgId:id). */
  async findById(id: string, orgId?: string): Promise<Plugin | null> {
    const cacheKey = `${orgId || 'anon'}:id:${id}`;
    return pluginCache.getOrSet(cacheKey, () => super.findById(id, orgId));
  }

  // -- Lifecycle hooks — emit events + invalidate cache ---------------------

  protected async onAfterCreate(entity: Plugin): Promise<void> {
    pluginCache.invalidatePattern(`${entity.orgId}:*`).catch((err) => {
      logger.debug('Cache invalidation failed after plugin create', { orgId: entity.orgId, error: errorMessage(err) });
    });
    entityEvents.emit({
      eventType: 'created',
      target: 'plugin',
      entityId: entity.id,
      orgId: entity.orgId,
      userId: entity.createdBy,
      timestamp: new Date(),
      attributes: entity as unknown as Record<string, unknown>,
    });
  }

  protected async onAfterUpdate(id: string, entity: Plugin): Promise<void> {
    pluginCache.invalidatePattern(`${entity.orgId}:*`).catch((err) => {
      logger.debug('Cache invalidation failed after plugin update', { orgId: entity.orgId, error: errorMessage(err) });
    });
    entityEvents.emit({
      eventType: 'updated',
      target: 'plugin',
      entityId: id,
      orgId: entity.orgId,
      userId: entity.updatedBy,
      timestamp: new Date(),
      attributes: entity as unknown as Record<string, unknown>,
    });
  }

  protected async onAfterDelete(id: string, entity: Plugin): Promise<void> {
    pluginCache.invalidatePattern(`${entity.orgId}:*`).catch((err) => {
      logger.debug('Cache invalidation failed after plugin delete', { orgId: entity.orgId, error: errorMessage(err) });
    });
    entityEvents.emit({
      eventType: 'deleted',
      target: 'plugin',
      entityId: id,
      orgId: entity.orgId,
      userId: entity.updatedBy,
      timestamp: new Date(),
      attributes: entity as unknown as Record<string, unknown>,
    });
  }

  /** Atomically deploy a new plugin version as default (clears old defaults for same name+org). */
  async deployVersion(
    data: PluginInsert,
    userId: string,
  ): Promise<Plugin> {
    return db.transaction(async (tx) => {
      // Lock existing defaults by name+org to prevent concurrent races
      await tx.execute(
        sql`SELECT id FROM ${schema.plugin}
            WHERE ${schema.plugin.name} = ${data.name}
              AND ${schema.plugin.orgId} = ${data.orgId}
              AND ${schema.plugin.isDefault} = true
            FOR UPDATE`,
      );

      // Unset old defaults for this plugin name in the org
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
            imageTag: data.imageTag,
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

      const result = upserted as unknown as Plugin;
      pluginCache.invalidatePattern(`${data.orgId}:*`).catch((err) => {
        logger.debug('Cache invalidation failed after plugin deploy', { orgId: data.orgId, error: errorMessage(err) });
      });
      return result;
    });
  }
}

export const pluginService = new PluginService();
