// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConflictError, ErrorCode, ForbiddenError, NotFoundError, entityEvents, createCacheService, createLogger, errorMessage, toComplianceAttributes } from '@pipeline-builder/api-core';
import { CoreConstants, ComputeType, PluginType, pluginImageRepository } from '@pipeline-builder/pipeline-core';
import {
  CrudService, buildPluginConditions, executeRows, getTenantContext, parseSemver, pluginResolutionOrderBy, runWithTenantContext,
  satisfiesVersionSpec, schema, semverOrderBy, viewerCacheSegment, withTenantTx, withViewerContext, type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { and, eq, inArray, isNull, ne, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

import { installingOrgs } from './ecosystem/install-notify.js';
import { listingsWithPublishers, versions as ecosystemVersions } from './ecosystem/store.js';
import { DEFAULT_PLUGIN_VERSION, shouldBecomeDefault } from '../helpers/default-version.js';
import { pipelinePluginRefs } from '../helpers/pipeline-plugin-refs.js';

const logger = createLogger('plugin-service');

/** Server-side cache for plugin reads. */
const pluginCache = createCacheService('plugin:', CoreConstants.CACHE_TTL_ENTITY);

type TenantTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

export type Plugin = typeof schema.plugin.$inferSelect;
export type PluginInsert = typeof schema.plugin.$inferInsert;
export type PluginUpdate = Partial<Omit<Plugin, 'id' | 'createdAt' | 'createdBy'>>;

/** The version fields {@link PluginService.findOrgsUsingVersion} reads. */
export interface VersionUsageRef {
  /** The row's id: its listing versions (published from it) reach their installers. */
  id?: string;
  orgId: string;
  name: string;
  version: string;
  isDefault: boolean;
  visibility: string | null;
  buildType?: string | null;
}

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
/**
 * Serialize every default-changing write to one (org, name) — deploys,
 * promotions, next-default promotion — on a transaction-scoped advisory lock,
 * so none of them can leave two defaults (even when no row exists yet to lock).
 */
async function lockPluginName(tx: TenantTx, orgId: string, name: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId} || ':' || ${name}))`);
}

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

    // Own keys only: `sortBy` is client input, and a plain lookup walks the
    // prototype (`?sortBy=constructor` returned a function, not a column).
    return Object.hasOwn(sortableColumns, sortBy) ? sortableColumns[sortBy] : null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return null; // Plugins are org-scoped, not project-scoped
  }

  /**
   * "Take one" ranking for lookups (`/plugins/lookup`, `/plugins/find`): the
   * shared resolution order — own org, then parent org, then the system
   * catalog; the default version; the HIGHEST semver — identical to the
   * pipeline service's contract check (`pluginResolutionOrderBy`).
   */
  protected findFirstOrderBy(_filter: Partial<PluginFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    return pluginResolutionOrderBy(orgId, parentOrgId);
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
    let demotedIds: string[] = [];

    const updated = await withTenantTx(async (tx) => {
      const [target] = await tx
        .select({ name: schema.plugin.name, orgId: schema.plugin.orgId })
        .from(schema.plugin)
        .where(and(...conditions));
      if (!target) return null;

      await lockPluginName(tx, target.orgId, target.name);

      const currentDefaults = await this.selectLiveDefaults(tx, target.orgId, target.name, id).for('update');
      for (const current of currentDefaults) assertMayOverwritePlugin(current, actor, access, 'default');
      demotedIds = currentDefaults.map((c) => c.id);

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
      // The demoted siblings changed too: the hook's org-wide sweep covers the
      // owner org's copies, the per-id sweep the other orgs' copies of them.
      await this.invalidateIds(demotedIds);
      try {
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
        id: schema.plugin.id,
        visibility: schema.plugin.visibility,
        createdBy: schema.plugin.createdBy,
        deletedAt: schema.plugin.deletedAt,
        frozenAt: schema.plugin.frozenAt,
        isDefault: schema.plugin.isDefault,
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
    await withTenantTx(async (tx) => {
      const [existing] = await this.selectVersionRow(tx, orgId, name, version);
      if (existing) {
        assertMayOverwritePlugin(existing, userId, access);
        await this.assertVersionMutable(tx, existing);
      }
      const currentDefaults = await this.selectLiveDefaults(tx, orgId, name);
      if (shouldBecomeDefault(version, existing?.isDefault === true, currentDefaults)) {
        for (const current of currentDefaults) assertMayOverwritePlugin(current, userId, access, 'default');
      }
    });
  }

  /**
   * Refuse to change a version that is immutable: FROZEN (a publish
   * request references it — `frozen_at` set) or LISTED (a listing version was
   * published from it). Unrequested private/org versions stay overwritable.
   */
  private async assertVersionMutable(tx: TenantTx, row: { id: string; frozenAt: Date | null }): Promise<void> {
    const reason = await this.immutabilityReason(tx, row);
    if (reason) {
      throw new ConflictError(
        reason === 'listed'
          ? 'This plugin version is published to the ecosystem and is immutable. Upload a new version instead.'
          : 'This plugin version is referenced by a publish request and is immutable. Upload a new version instead.',
        ErrorCode.PLUGIN_VERSION_FROZEN,
      );
    }
  }

  /** Why a version is immutable (`frozen` / `listed`), or null when it isn't. */
  private async immutabilityReason(tx: TenantTx, row: { id: string; frozenAt: Date | null }): Promise<'frozen' | 'listed' | null> {
    if (row.frozenAt) return 'frozen';
    return (await this.isListed(tx, row.id)) ? 'listed' : null;
  }

  /** Whether any listing version was published from this org row. */
  private async isListed(tx: TenantTx, pluginId: string): Promise<boolean> {
    return (await executeRows(tx, sql`SELECT 1 FROM plugin_listing_versions WHERE source_plugin_id = ${pluginId} LIMIT 1`)).length > 0;
  }

  /**
   * Freeze a version: called when a publish request references it.
   * The request pins `digest`; if the stored image digest differs the freeze
   * fails closed (409 PLUGIN_DIGEST_MISMATCH) — what was reviewed must be what
   * is published. Idempotent: an already-frozen version keeps its first
   * `frozen_at`. `digest` is null for a version that produces no image.
   *
   * @throws NotFoundError when the version is not a live row of `orgId`.
   */
  async freezeVersion(orgId: string, pluginId: string, digest: string | null): Promise<Plugin> {
    const frozen = await withTenantTx(async (tx) => {
      const [row] = await tx
        .select({ id: schema.plugin.id, imageDigest: schema.plugin.imageDigest })
        .from(schema.plugin)
        .where(and(eq(schema.plugin.id, pluginId), eq(schema.plugin.orgId, orgId), isNull(schema.plugin.deletedAt)))
        .for('update');
      if (!row) throw new NotFoundError('Plugin not found');
      if ((row.imageDigest ?? null) !== (digest ?? null)) {
        throw new ConflictError(
          'The plugin version\'s image digest does not match the digest the request pinned.',
          ErrorCode.PLUGIN_DIGEST_MISMATCH,
        );
      }
      const [updated] = await tx
        .update(schema.plugin)
        .set({ frozenAt: sql`coalesce(${schema.plugin.frozenAt}, now())` })
        .where(eq(schema.plugin.id, pluginId))
        .returning();
      return updated as Plugin;
    });
    await this.invalidate(frozen);
    return frozen;
  }

  /**
   * Whether `row` may be edited / deleted, and if not why. Used by the update,
   * delete and yank routes. Runs in its own read transaction.
   */
  async versionImmutability(row: { id: string; frozenAt: Date | null }): Promise<'frozen' | 'listed' | null> {
    return withTenantTx((tx) => this.immutabilityReason(tx, row));
  }

  /**
   * Number of the org's live pipelines that reference this version: a step
   * (or the synth step) naming the plugin whose `filter.version` spec it
   * satisfies — or, for the default version, a reference with no version spec
   * (those resolve to the default). Same JSON walk as `GET /plugin-usage`, plus
   * the synth plugin and the version spec.
   */
  async countPipelinesUsing(orgId: string, plugin: { name: string; version: string; isDefault: boolean }): Promise<number> {
    const rows = await withTenantTx(async (tx) => executeRows<{ spec: string | null; cnt: string | number }>(tx, sql`
      SELECT ref->'filter'->>'version' AS spec,
             COUNT(DISTINCT p.id) AS cnt
        FROM pipelines p,
             ${pipelinePluginRefs()}
       WHERE p.is_active = true
         AND p.deleted_at IS NULL
         AND p.org_id = ${orgId}
         AND ref->>'name' = ${plugin.name}
       GROUP BY ref->'filter'->>'version'
    `));
    let total = 0;
    for (const row of rows) {
      const uses = row.spec == null ? plugin.isDefault : satisfiesVersionSpec(plugin.version, row.spec);
      if (!uses) continue;
      const n = typeof row.cnt === 'number' ? row.cnt : parseInt(String(row.cnt), 10);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  }

  /**
   * Orgs whose pipelines use this version, for the N14 deprecation notice.
   * Runs ACROSS orgs (superadmin tenant context), so its result must only ever
   * address the consuming orgs themselves — never be shown to the owner.
   *
   * Two audiences, unioned:
   *  - the OWNER org's own use: its pipeline definitions naming the plugin
   *    unqualified with a version spec this version satisfies (no spec ⇒ only
   *    the default), and deployed step manifests with the exact name@version
   *    from its own namespace — which also catches teams that deployed a
   *    parent's shared plugin;
   *  - the INSTALLING orgs of every listing version published
   *    FROM this row: active explicit installs whose range reaches the
   *    version, plus — for an Official listing — orgs using it through the
   *    implicit install. A `public` row no longer reaches any other org by
   *    itself; only listings do.
   */
  async findOrgsUsingVersion(plugin: VersionUsageRef): Promise<string[]> {
    const owner = plugin.orgId.toLowerCase();
    const repo = pluginImageRepository(plugin);

    const own = await runWithTenantContext({ isSuperAdmin: true }, async () => {
      const defs = await withTenantTx(async (tx) => executeRows<{ org_id: string; spec: string | null }>(tx, sql`
        SELECT DISTINCT p.org_id, ref->'filter'->>'version' AS spec
          FROM pipelines p,
               ${pipelinePluginRefs()}
         WHERE p.is_active = true
           AND p.deleted_at IS NULL
           AND ref->>'name' = ${plugin.name}
           AND COALESCE(ref->>'publisher', '') = ''
           AND p.org_id = ${owner}
      `));
      const m = schema.pipelineStepManifest;
      const ownNamespace = sql`${m.pluginPublisher} IS NULL AND ${repo ? sql`(${m.imageRepository} = ${repo} OR ${m.orgId} = ${owner})` : sql`${m.orgId} = ${owner}`}`;
      const deployed = await withTenantTx(async (tx) => tx
        .selectDistinct({ orgId: m.orgId })
        .from(m)
        .where(and(eq(m.pluginName, plugin.name), eq(m.pluginVersion, plugin.version), ownNamespace,
          // A soft-deleted pipeline's manifest is no longer a use.
          sql`EXISTS (SELECT 1 FROM pipelines pl WHERE pl.id = ${m.pipelineId} AND pl.deleted_at IS NULL)`)));

      const orgs = new Set<string>();
      for (const row of defs) {
        const uses = row.spec == null ? plugin.isDefault : satisfiesVersionSpec(plugin.version, row.spec);
        if (uses && row.org_id) orgs.add(row.org_id.toLowerCase());
      }
      for (const row of deployed) if (row.orgId) orgs.add(row.orgId.toLowerCase());
      return orgs;
    });

    if (plugin.id) {
      const listed = await ecosystemVersions.bySourcePlugins([plugin.id]);
      const owners = await listingsWithPublishers(listed.map((v) => v.listingId));
      for (const v of listed) {
        const { listing, publisher } = owners.get(v.listingId) ?? { listing: null, publisher: null };
        if (!listing || !publisher) continue;
        for (const o of await installingOrgs(publisher, listing, v.version)) own.add(o.orgId);
      }
    }
    return [...own].sort();
  }

  /**
   * Delete a version (soft), with the safety rules:
   * - FROZEN (a pending publish request references it): never deletable
   *   (409 PLUGIN_VERSION_FROZEN) — the request pins this exact version.
   * - IN USE by the org's pipelines, or LISTED (a listing version was published
   *   from it): refused with 409 PLUGIN_VERSION_IN_USE unless `force` — the route
   *   pairs `force` with a step-up. A listing keeps serving its own
   *   `public/*` copy, so deleting the org's source row doesn't break installs.
   * Deleting the default promotes the next one ({@link promoteNextDefault}).
   * The row's quota snapshot is cleared on the tombstone so the slot is refunded
   * at most once (the route refunds `existing.quotaResetAt`). Returns the deleted
   * row, or null when nothing in the caller's org matched.
   */
  async deleteVersion(existing: Plugin, orgId: string, userId: string, opts: { force: boolean }): Promise<{ deleted: Plugin | null; inUse: number; listed: boolean; promoted: Plugin | null }> {
    const { frozen, listed, inUse } = await this.deleteBlockers(existing, orgId);
    if (frozen) {
      throw new ConflictError(
        'This plugin version is referenced by a publish request and cannot be deleted.',
        ErrorCode.PLUGIN_VERSION_FROZEN,
      );
    }
    if ((inUse > 0 || listed) && !opts.force) {
      const why = [
        ...(inUse > 0 ? [`used by ${inUse} pipeline${inUse === 1 ? '' : 's'}`] : []),
        ...(listed ? ['published to the ecosystem'] : []),
      ].join(' and ');
      throw new ConflictError(
        `This plugin version is ${why}. Delete with force=true (requires re-authentication) to proceed.`,
        ErrorCode.PLUGIN_VERSION_IN_USE,
      );
    }
    const deleted = await this.delete(existing.id, orgId, userId);
    if (deleted && existing.quotaResetAt) await this.clearQuotaSnapshot(existing.id);
    const promoted = deleted && existing.isDefault ? await this.promoteNextDefault(orgId, existing, userId) : null;
    return { deleted, inUse, listed, promoted };
  }

  /**
   * What stands in the way of deleting `row`: a pending publish request
   * (`frozen`, never deletable), a listing published from it (`listed`), and
   * the number of the org's pipelines resolving to it (`inUse`).
   */
  async deleteBlockers(row: Plugin, orgId: string): Promise<{ frozen: boolean; listed: boolean; inUse: number }> {
    const reason = await this.versionImmutability(row);
    return {
      frozen: reason === 'frozen',
      listed: reason === 'listed',
      inUse: await this.countPipelinesUsing(orgId, row),
    };
  }

  /** Forget a version's quota snapshot once its slot has been refunded. */
  async clearQuotaSnapshot(pluginId: string): Promise<void> {
    await withTenantTx((tx) => tx
      .update(schema.plugin)
      .set({ quotaResetAt: null })
      .where(eq(schema.plugin.id, pluginId)));
  }

  /**
   * Mark a version deprecated — or clear it. A deprecated version keeps
   * resolving, but lookups carry a warning, synth prints it and AI selection
   * stops offering it. `lifecycle` mirrors `deprecatedAt` for catalog filters.
   * A yanked version stays yanked (its lifecycle is not overwritten).
   */
  async setDeprecated(
    existing: Plugin,
    orgId: string,
    userId: string,
    opts: { deprecated: boolean; message?: string | null },
  ): Promise<Plugin | null> {
    const now = new Date();
    const yanked = existing.lifecycle === 'yanked' || existing.yankedAt !== null;
    const updated = await withTenantTx(async (tx) => {
      const [row] = await tx
        .update(schema.plugin)
        .set(opts.deprecated
          ? {
            deprecatedAt: existing.deprecatedAt ?? now,
            deprecationMessage: opts.message ?? null,
            ...(yanked ? {} : { lifecycle: 'deprecated' as const }),
            updatedAt: now,
            updatedBy: userId,
          }
          : {
            deprecatedAt: null,
            deprecationMessage: null,
            ...(yanked || existing.lifecycle !== 'deprecated' ? {} : { lifecycle: 'production' as const }),
            updatedAt: now,
            updatedBy: userId,
          })
        .where(and(eq(schema.plugin.id, existing.id), eq(schema.plugin.orgId, orgId), isNull(schema.plugin.deletedAt)))
        .returning();
      return (row as Plugin | undefined) ?? null;
    });
    if (updated) await this.afterWrite(updated, userId);
    return updated;
  }

  /**
   * Yank a version: it stops resolving for ranges / `latest` / the
   * default, while an exact pin still finds it (and is told why). A LISTED
   * version is yanked by the system org on request, never by the org (409
   * PLUGIN_VERSION_FROZEN). Yanking the default promotes the next one.
   */
  async yankVersion(existing: Plugin, orgId: string, userId: string, reason: string): Promise<{ yanked: Plugin | null; promoted: Plugin | null }> {
    if (await withTenantTx((tx) => this.isListed(tx, existing.id))) {
      throw new ConflictError(
        'This plugin version is published to the ecosystem; request a yank from the ecosystem instead.',
        ErrorCode.PLUGIN_VERSION_FROZEN,
      );
    }
    const now = new Date();
    const yanked = await withTenantTx(async (tx) => {
      const [row] = await tx
        .update(schema.plugin)
        .set({ lifecycle: 'yanked', yankedAt: now, yankReason: reason, isDefault: false, updatedAt: now, updatedBy: userId })
        .where(and(eq(schema.plugin.id, existing.id), eq(schema.plugin.orgId, orgId), isNull(schema.plugin.deletedAt)))
        .returning();
      return (row as Plugin | undefined) ?? null;
    });
    if (yanked) await this.afterWrite(yanked, userId);
    const promoted = yanked && existing.isDefault ? await this.promoteNextDefault(orgId, existing, userId) : null;
    return { yanked, promoted };
  }

  /**
   * After the default `removed` was deleted or yanked, make the next version
   * the default: the highest live, active, stable, non-yanked version whose
   * major is not above the removed one's (a new major is never auto-promoted,
   * ). No-op if a default already exists again (a concurrent deploy) or no
   * candidate qualifies — resolution then falls back to the highest version.
   */
  async promoteNextDefault(orgId: string, removed: { name: string; version: string }, userId: string): Promise<Plugin | null> {
    const removedMajor = parseSemver(removed.version)?.major ?? Number.MAX_SAFE_INTEGER;
    const promoted = await withTenantTx(async (tx) => {
      await lockPluginName(tx, orgId, removed.name);
      const live = await this.selectLiveDefaults(tx, orgId, removed.name);
      if (live.length > 0) return null;

      const candidates = await tx
        .select({ id: schema.plugin.id, version: schema.plugin.version })
        .from(schema.plugin)
        .where(and(
          eq(schema.plugin.orgId, orgId),
          eq(schema.plugin.name, removed.name),
          eq(schema.plugin.isActive, true),
          isNull(schema.plugin.deletedAt),
          isNull(schema.plugin.yankedAt),
          ne(schema.plugin.lifecycle, 'yanked'),
        ))
        .orderBy(...semverOrderBy(schema.plugin.version));
      const next = candidates.find((c) => {
        const v = parseSemver(c.version);
        return v !== null && v.prerelease.length === 0 && v.major <= removedMajor;
      });
      if (!next) return null;

      const [row] = await tx
        .update(schema.plugin)
        .set({ isDefault: true, updatedAt: new Date(), updatedBy: userId })
        .where(eq(schema.plugin.id, next.id))
        .returning();
      return (row as Plugin | undefined) ?? null;
    });
    if (promoted) await this.afterWrite(promoted, userId);
    return promoted;
  }

  /** Post-write lifecycle for the service's own direct writes (cache + event). */
  private async afterWrite(row: Plugin, userId: string): Promise<void> {
    try {
      await this.onAfterUpdate(row.id, row, userId);
    } catch (err) {
      logger.warn('Lifecycle hook failed', { error: errorMessage(err) });
    }
  }

  /** Cache invalidation alone (no entity event) — for writes that change no
   *  compliance-relevant attribute, like a freeze. */
  private async invalidate(row: Plugin): Promise<void> {
    try {
      await pluginCache.invalidatePattern(`${row.orgId}:*`);
      await pluginCache.invalidatePattern(`*:id:${row.id}`);
    } catch (err) {
      logger.debug('Cache invalidation failed', { orgId: row.orgId, error: errorMessage(err) });
    }
  }

  /** Drop every org's cached copy of these rows (see {@link invalidateAndEmit}). */
  private async invalidateIds(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      try {
        await pluginCache.invalidatePattern(`*:id:${id}`);
      } catch (err) {
        logger.debug('Cache invalidation failed', { id, error: errorMessage(err) });
      }
    }
  }

  /** The live default version(s) of `name` — the rows a deploy (or a promote
   *  of `exceptId`) would demote. */
  private selectLiveDefaults(tx: TenantTx, orgId: string, name: string, exceptId?: string) {
    return tx
      .select({
        id: schema.plugin.id,
        version: schema.plugin.version,
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
    const { row, created, demotedIds } = await withTenantTx(async (tx) => {
      // Serialize ALL deploys for the same (org, name) — including the FIRST,
      // when no default row exists yet for the `FOR UPDATE` below to lock. Two
      // concurrent first-time deploys of a brand-new plugin name would otherwise
      // each lock zero rows, each unset zero defaults, and each insert
      // isDefault=true → TWO defaults (ambiguous "the default" resolution). A
      // transaction-scoped advisory lock keyed on (orgId, name) makes them run
      // one-at-a-time regardless of whether any row exists.
      await lockPluginName(tx, data.orgId!, data.name);

      // The row this deploy's ON CONFLICT would land on (any visibility, any
      // soft-delete state). Serialized by the advisory lock above, so the check
      // can't be raced by a concurrent deploy of the same name.
      // `version` falls back to the column default, which is what the INSERT would store.
      const version = data.version ?? DEFAULT_PLUGIN_VERSION;
      const [existing] = await this.selectVersionRow(tx, data.orgId!, data.name, version).for('update');
      if (existing) {
        assertMayOverwritePlugin(existing, userId, access);
        // Authoritative immutability check: the upload route's
        // pre-check is unlocked, so a publish request could freeze this version
        // between that check and here. Re-checked under the advisory lock.
        await this.assertVersionMutable(tx, existing);
      }

      // Lock the current live default(s) for this name. Whether the upload takes
      // over as the default is one rule: not for a new major, a prerelease
      // or an older version (see shouldBecomeDefault).
      const currentDefaults = await this.selectLiveDefaults(tx, data.orgId!, data.name)
        .for('update');
      const becomeDefault = shouldBecomeDefault(version, existing?.isDefault === true, currentDefaults);

      if (becomeDefault) {
        // Taking over the default is a change to the current default row(s), so
        // the caller needs the same write access to them as to an overwrite.
        // Without this, any `plugins:write` member could demote another author's
        // private plugin by uploading a version of the same name.
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
      }

      // Upsert the version (default only per the rule above)
      const [upserted] = await tx
        .insert(schema.plugin)
        .values({
          ...data,
          version,
          pluginType: data.pluginType as PluginType,
          computeType: data.computeType as ComputeType,
          visibility: data.visibility,
          // Catalog ownership: always the creating user on the insert branch (a
          // client-supplied ownerId is ignored, matching the pipeline convention
          // so a member can't mint a plugin owned by someone else). Not touched on
          // the conflict (re-upload) branch, so a re-upload never steals ownership.
          ownerId: userId,
          ownerType: 'user',
          isDefault: becomeDefault,
          isActive: true,
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target: [schema.plugin.name, schema.plugin.version, schema.plugin.orgId],
          set: {
            description: data.description,
            ...(data.category !== undefined ? { category: data.category } : {}),
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
            // The re-uploaded version's contract, docs and trust metadata
            // replace the old ones — a re-upload is a new artefact.
            requiredMetadata: data.requiredMetadata,
            requiredVars: data.requiredVars,
            metadataTypes: data.metadataTypes,
            varsTypes: data.varsTypes,
            smokeTest: data.smokeTest ?? null,
            networkEgress: data.networkEgress,
            readmeMd: data.readmeMd ?? null,
            readmeHtml: data.readmeHtml ?? null,
            license: data.license ?? null,
            changelog: data.changelog ?? null,
            homepageUrl: data.homepageUrl ?? null,
            sourceUrl: data.sourceUrl ?? null,
            documentationUrl: data.documentationUrl ?? null,
            icon: data.icon ?? null,
            // Catalog metadata + its provenance describe THIS upload.
            summary: data.summary ?? null,
            displayName: data.displayName ?? null,
            metadataSources: data.metadataSources ?? {},
            // The re-upload charged its own quota slot; a later delete refunds that one.
            quotaResetAt: data.quotaResetAt ?? null,
            // Scan facts describe the OLD image; the build worker records the new
            // image's. Null until then, never stale.
            vulnCritical: data.vulnCritical ?? null,
            vulnHigh: data.vulnHigh ?? null,
            vulnMedium: data.vulnMedium ?? null,
            vulnLow: data.vulnLow ?? null,
            vulnCriticalFixable: data.vulnCriticalFixable ?? null,
            vulnHighFixable: data.vulnHighFixable ?? null,
            scannedAt: data.scannedAt ?? null,
            // A rescan flag described the OLD image; the new one starts unflagged.
            scanFlaggedAt: null,
            scanFlag: null,
            runAsRoot: data.runAsRoot ?? null,
            visibility: data.visibility,
            isDefault: becomeDefault,
            isActive: true,
            updatedBy: userId,
            updatedAt: new Date(),
          },
        })
        .returning();

      return {
        row: upserted as Plugin,
        created: !existing,
        demotedIds: becomeDefault ? currentDefaults.map((c) => c.id).filter((id) => id !== existing?.id) : [],
      };
    });
    // After COMMIT, never inside the transaction: a concurrent read between an
    // in-tx invalidation and the commit would re-cache the pre-deploy rows.
    await this.invalidateIds(demotedIds);
    try {
      await this.invalidateAndEmit(created ? 'created' : 'updated', row.id, row, userId);
    } catch (err) {
      logger.warn('Lifecycle hook failed', { error: errorMessage(err) });
    }
    return row;
  }
}

export const pluginService = new PluginService();
