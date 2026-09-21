// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConflictError, ForbiddenError, entityEvents, createCacheService, createLogger, errorMessage, toComplianceAttributes } from '@pipeline-builder/api-core';
import { CoreConstants, ComputeType, PluginType } from '@pipeline-builder/pipeline-core';
import { CrudService, buildPluginConditions, getTenantContext, schema, viewerCacheSegment, withTenantTx, withViewerContext, type PluginFilter } from '@pipeline-builder/pipeline-data';
import { and, eq, inArray, isNull, ne, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

const logger = createLogger('plugin-service');

/** Server-side cache for plugin reads. */
const pluginCache = createCacheService('plugin:', CoreConstants.CACHE_TTL_ENTITY);

type TenantTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

export type Plugin = typeof schema.plugin.$inferSelect;
export type PluginInsert = typeof schema.plugin.$inferInsert;
export type PluginUpdate = Partial<Omit<Plugin, 'id' | 'createdAt' | 'createdBy'>>;

// `toComplianceAttributes` (secret redaction for compliance events) is shared
// in api-core — it was a byte-identical copy here + in pipeline-service, and a
// security-critical function must not drift. Re-exported for existing importers.
export { toComplianceAttributes };

/**
 * The deploying caller's authority on the visibility ladder, captured from the
 * request (`isSystemAdmin(req)`, `userHasPermission(req, 'plugins:publish')`) —
 * the same shape `CrudService.bulkDelete` takes. Plain data so it survives the
 * trip through a BullMQ build job to the worker that performs the deploy.
 */
export interface WriteAccess {
  isSystemAdmin: boolean;
  canPublish: boolean;
}

/**
 * Refuse to let a deploy's ON CONFLICT branch overwrite a plugin version the
 * caller could not modify through PUT/DELETE, or resurrect a tombstone without
 * restore's step-up. Mirrors `checkVisibilityWriteAccess` rung for rung.
 */
export function assertMayOverwritePlugin(
  existing: { visibility: string | null; createdBy: string | null; deletedAt: Date | null },
  userId: string,
  access: WriteAccess,
  /** `version`: the row being overwritten. `default`: the live default a deploy would demote. */
  target: 'version' | 'default' = 'version',
): void {
  if (existing.deletedAt) {
    throw new ConflictError(
      'A deleted plugin with this name and version exists. Restore it or purge it before uploading it again.',
    );
  }
  if (access.isSystemAdmin) return;
  if (existing.visibility === 'public' && !access.canPublish) {
    throw new ForbiddenError('You lack permission to modify this public resource.');
  }
  // Fail closed on an absent caller — an empty userId must never match an empty author.
  if (existing.visibility === 'private' && (!userId || existing.createdBy !== userId)) {
    throw new ConflictError(target === 'default'
      ? 'The current default version of this plugin belongs to another author.'
      : 'A plugin with this name and version already exists and belongs to another author.');
  }
}

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
    // Stamp the caller so the `private` rung matches the author's own rows (see
    // pipeline-data viewer-context). Without it the author can't see their own
    // private plugin.
    return buildPluginConditions(withViewerContext(filter), orgId, parentOrgId);
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

  /** findById with server-side cache (keyed by orgId[:p:parentOrgId]:v:viewer:id).
   *  The parent segment keeps a team's parent-widened read from colliding with the
   *  own-org-only read under the same orgId. */
  async findById(id: string, orgId?: string, parentOrgId?: string): Promise<Plugin | null> {
    // The VIEWER is part of the key because it is part of the answer: the read
    // predicate is `org_id = O AND (visibility <> 'private' OR created_by = V)`,
    // so two members of one org legitimately see different rows for one id.
    // Keyed on org alone, an author's private draft was served from cache to the
    // rest of the org. See `viewerCacheSegment`.
    const cacheKey = `${orgId || 'anon'}${parentOrgId ? `:p:${parentOrgId}` : ''}:v:${viewerCacheSegment()}:id:${id}`;
    return pluginCache.getOrSet(cacheKey, () => super.findById(id, orgId, parentOrgId));
  }

  /**
   * Batched, EXACT-id sibling of {@link findById} for bulk routes: the rows among
   * `ids` visible to `orgId` (own org + public; soft-deleted excluded). Uncached.
   * `inArray` (not the prefix-matching id filter) so a bulk visibility check sees
   * precisely the rows named.
   */
  async findByIds(ids: string[], orgId?: string, parentOrgId?: string): Promise<Plugin[]> {
    if (ids.length === 0) return [];
    const conditions = this.buildConditions({} as Partial<PluginFilter>, orgId, parentOrgId);
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.plugin)
      .where(and(inArray(schema.plugin.id, ids), ...conditions))
      .then((rows) => rows as unknown as Plugin[]));
  }

  // -- Lifecycle hooks — emit events + invalidate cache ---------------------

  private async invalidateAndEmit(eventType: 'created' | 'updated' | 'deleted', id: string, entity: Plugin, userId: string): Promise<void> {
    try {
      await pluginCache.invalidatePattern(`${entity.orgId}:*`);
      // Cross-org sweep, UNCONDITIONAL. A plugin is cached under every viewing
      // org's key whenever it is visible to them — system-org content (shown to
      // every tenant) and any `public` row alike — while a mutation only ever
      // runs under the owner's tenant. Gating on `orgId === SYSTEM_ORG_ID`
      // covered the first case and missed the second, so a public plugin owned
      // by an ordinary org went stale in every OTHER org until its TTL, and a
      // demotion left the pre-demotion copy readable there. Owner org and
      // visibility both drop out of the rule this way.
      await pluginCache.invalidatePattern(`*:id:${entity.id}`);
    } catch (err) {
      logger.debug(`Cache invalidation failed after plugin ${eventType}`, { orgId: entity.orgId, error: errorMessage(err) });
    }
    // Carry the owning org's parent (when the mutation ran under a team's tenant
    // context) so async compliance eval sees the same parent `propagateToChildren`
    // rules the live path does. Only trust the context parent when its org matches
    // the entity's — a cross-org mutation must not inherit the caller's parent.
    const tenant = getTenantContext();
    const parentOrgId = tenant?.orgId === entity.orgId ? tenant?.parentOrgId : undefined;
    // Project to compliance-safe attributes: the plugin row's `env`/`buildArgs`
    // maps hold secret VALUES that must never land in Redis / travel to the
    // compliance service. See toComplianceAttributes — keys are preserved for
    // rule evaluation, values are redacted.
    const attributes = toComplianceAttributes(entity) as Record<string, unknown>;
    entityEvents.emit({ eventType, target: 'plugin', entityId: id, orgId: entity.orgId, parentOrgId, userId, timestamp: new Date(), attributes });
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

  /** A restored plugin re-enters the live catalog, so it must be re-evaluated for
   *  compliance and its caches invalidated — symmetric with delete. Emitted as
   *  'updated' (the entity keeps its id/history) so the compliance subscriber
   *  re-checks it rather than treating it as gone. */
  protected async onAfterRestore(id: string, entity: Plugin, userId: string): Promise<void> {
    await this.invalidateAndEmit('updated', id, entity, userId);
  }

  /**
   * Update a plugin. Promoting it to the default (`isDefault: true`) is not a
   * plain column write: a default is singular per (org, name), so the other
   * versions' default flag is cleared IN THE SAME transaction — serialized on
   * the same (org, name) advisory lock {@link deployVersion} takes, so a
   * concurrent promote/deploy can't leave two defaults. Demoting the current
   * default is a change to that row, so the caller needs write access to it on
   * the visibility ladder (`access`, defaulting to the least privilege).
   */
  async update(
    id: string,
    data: PluginUpdate,
    orgId: string,
    userId: string,
    access: WriteAccess = { isSystemAdmin: false, canPublish: false },
  ): Promise<Plugin | null> {
    if (data.isDefault !== true) return super.update(id, data, orgId, userId);

    // Same target predicate as CrudService.update (read access + own-org pin +
    // exact id); `orgId` is never writable.
    const conditions = [
      ...this.buildConditions({ id } as Partial<PluginFilter>, orgId),
      ...(orgId ? [eq(schema.plugin.orgId, orgId)] : []),
      eq(schema.plugin.id, String(id).toLowerCase()),
    ];
    const { orgId: _ignoredOrgId, ...safeData } = data;
    const now = new Date();
    const actor = userId || 'system';

    const updated = await withTenantTx(async (tx) => {
      const [target] = await tx
        .select({ name: schema.plugin.name, orgId: schema.plugin.orgId })
        .from(schema.plugin)
        .where(and(...conditions));
      if (!target) return null;

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${target.orgId} || ':' || ${target.name}))`,
      );

      const currentDefaults = await this.selectLiveDefaults(tx, target.orgId, target.name, id).for('update');
      for (const current of currentDefaults) assertMayOverwritePlugin(current, actor, access, 'default');

      await tx
        .update(schema.plugin)
        .set({ isDefault: false, updatedAt: now, updatedBy: actor })
        .where(and(
          eq(schema.plugin.name, target.name),
          eq(schema.plugin.orgId, target.orgId),
          eq(schema.plugin.isDefault, true),
          ne(schema.plugin.id, String(id).toLowerCase()),
        ));

      const [row] = await tx
        .update(schema.plugin)
        .set({ ...safeData, updatedAt: now, updatedBy: actor })
        .where(and(...conditions))
        .returning();
      return (row as Plugin | undefined) ?? null;
    });

    if (updated) {
      try {
        // The demoted siblings changed too — the org-wide invalidation in the
        // hook covers their cached copies.
        await this.onAfterUpdate(id, updated, userId);
      } catch (err) {
        logger.warn('Lifecycle hook failed', { error: errorMessage(err) });
      }
    }
    return updated;
  }

  /**
   * Bulk update. Runs the SAME post-update lifecycle as a single-row
   * {@link update} for every row that changed — cache invalidation (so reads
   * don't serve the pre-update row until the TTL lapses) and the `updated`
   * entity event the compliance subscriber re-evaluates. The base
   * `CrudService.updateMany` fires no hooks.
   */
  async updateMany(
    filter: Partial<PluginFilter>,
    data: PluginUpdate,
    orgId: string,
    userId: string,
  ): Promise<Plugin[]> {
    const updated = await super.updateMany(filter, data, orgId, userId);
    for (const row of updated) {
      try {
        await this.onAfterUpdate(row.id, row, userId);
      } catch (err) {
        logger.warn('Lifecycle hook failed', { error: errorMessage(err) });
      }
    }
    return updated;
  }

  /**
   * The `(name, version, org_id)` row a deploy would overwrite, IGNORING the
   * visibility ladder and soft-delete state (the unique index ignores both).
   */
  private selectVersionRow(tx: TenantTx, orgId: string, name: string, version: string) {
    return tx
      .select({
        visibility: schema.plugin.visibility,
        createdBy: schema.plugin.createdBy,
        deletedAt: schema.plugin.deletedAt,
      })
      .from(schema.plugin)
      .where(and(eq(schema.plugin.name, name), eq(schema.plugin.version, version), eq(schema.plugin.orgId, orgId)));
  }

  /**
   * Fail-fast pre-check for the upload routes: throws the same typed refusal
   * {@link deployVersion} would, BEFORE quota is spent on an image build that
   * could never be persisted. Unlocked — `deployVersion` re-checks under its
   * lock, which is the authoritative guarantee.
   */
  async assertDeployable(orgId: string, name: string, version: string, userId: string, access: WriteAccess): Promise<void> {
    const [existing, currentDefaults] = await withTenantTx(async (tx) => [
      (await this.selectVersionRow(tx, orgId, name, version))[0],
      await this.selectLiveDefaults(tx, orgId, name),
    ] as const);
    if (existing) assertMayOverwritePlugin(existing, userId, access);
    for (const current of currentDefaults) assertMayOverwritePlugin(current, userId, access, 'default');
  }

  /** The live default version(s) of `name` — the rows a deploy (or a promote
   *  of `exceptId`) would demote. */
  private selectLiveDefaults(tx: TenantTx, orgId: string, name: string, exceptId?: string) {
    return tx
      .select({
        visibility: schema.plugin.visibility,
        createdBy: schema.plugin.createdBy,
        deletedAt: schema.plugin.deletedAt,
      })
      .from(schema.plugin)
      .where(and(
        eq(schema.plugin.name, name),
        eq(schema.plugin.orgId, orgId),
        eq(schema.plugin.isDefault, true),
        isNull(schema.plugin.deletedAt),
        ...(exceptId ? [ne(schema.plugin.id, String(exceptId).toLowerCase())] : []),
      ));
  }

  /**
   * Atomically deploy a plugin version as default (clears old defaults for same
   * name+org). Re-deploying an existing `(name, version)` updates it in place —
   * but only when that row is LIVE and the caller may write it per the
   * visibility ladder (see {@link assertMayOverwritePlugin}). The unique index is
   * org-wide and blind to visibility and soft-delete, so without that check the
   * ON CONFLICT branch let any `plugins:write` member overwrite another author's
   * private plugin or a public one without `plugins:publish`, and silently
   * un-delete a tombstone past restore's step-up.
   */
  async deployVersion(
    data: PluginInsert,
    userId: string,
    access: WriteAccess,
  ): Promise<Plugin> {
    return withTenantTx(async (tx) => {
      // Serialize ALL deploys for the same (org, name) — including the FIRST,
      // when no default row exists yet for the `FOR UPDATE` below to lock. Two
      // concurrent first-time deploys of a brand-new plugin name would otherwise
      // each lock zero rows, each unset zero defaults, and each insert
      // isDefault=true → TWO defaults (ambiguous "the default" resolution). A
      // transaction-scoped advisory lock keyed on (orgId, name) makes them run
      // one-at-a-time regardless of whether any row exists.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${data.orgId} || ':' || ${data.name}))`,
      );

      // The row this deploy's ON CONFLICT would land on (any visibility, any
      // soft-delete state). Serialized by the advisory lock above, so the check
      // can't be raced by a concurrent deploy of the same name.
      // `version` falls back to the column default, which is what the INSERT would store.
      const [existing] = await this.selectVersionRow(tx, data.orgId!, data.name, data.version ?? '1.0.0').for('update');
      if (existing) assertMayOverwritePlugin(existing, userId, access);

      // Lock the current live default(s) for this name. Deploying makes the new
      // version the default, which takes that status away from the current one —
      // a change to that row, so the caller needs the same write access to it as
      // to an overwrite. Without this, any `plugins:write` member could demote
      // another author's private plugin by uploading a version of the same name.
      const currentDefaults = await this.selectLiveDefaults(tx, data.orgId!, data.name)
        .for('update');
      for (const current of currentDefaults) assertMayOverwritePlugin(current, userId, access, 'default');

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
          visibility: data.visibility,
          // Catalog ownership: always the creating user on the insert branch (a
          // client-supplied ownerId is ignored, matching the pipeline convention
          // so a member can't mint a plugin owned by someone else). Not touched on
          // the conflict (re-upload) branch, so a re-upload never steals ownership.
          ownerId: userId,
          ownerType: 'user',
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
            buildType: data.buildType,
            // A re-upload is a new image: the old digest/signature no longer
            // describes this row (null when the new version builds no image).
            imageDigest: data.imageDigest ?? null,
            imageSource: data.imageSource ?? null,
            visibility: data.visibility,
            isDefault: true,
            isActive: true,
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
