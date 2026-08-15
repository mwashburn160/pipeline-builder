// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { entityEvents, createCacheService } from '@pipeline-builder/api-core';
import { CoreConstants, AccessModifier } from '@pipeline-builder/pipeline-core';
import { CrudService, buildPipelineConditions, getTenantContext, schema, withTenantTx, type PipelineFilter } from '@pipeline-builder/pipeline-data';
import { SQL, eq, and, sql, inArray } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Server-side cache for pipeline reads. */
const pipelineCache = createCacheService('pipeline:', CoreConstants.CACHE_TTL_ENTITY);

export type Pipeline = typeof schema.pipeline.$inferSelect;
export type PipelineInsert = typeof schema.pipeline.$inferInsert;
export type PipelineUpdate = Partial<Omit<Pipeline, 'id' | 'createdAt' | 'createdBy'>>;

/** Marker written in place of a redacted secret VALUE. */
const REDACTED = '[REDACTED]';

/**
 * Map keys whose (string→string) VALUES are secret material. The pipeline row's
 * secrets live nested inside `props` (a serialized BuilderProps): `props.synth.env`,
 * per-step `props.stages[].steps[].env`, and step `buildArgs` maps all hold
 * secret values (see packages/pipeline-core/.../stage-builder.ts, source-types.ts).
 */
const SECRET_MAP_KEYS = new Set(['env', 'buildArgs']);

/**
 * Scalar keys that themselves carry a secret string. `props` can embed a source
 * `token` (source-types.ts: `token?: SecretValue | string`) plus assorted
 * password/credential fields. Applied only to string values so booleans and
 * arrays are left intact.
 */
function isSecretScalarKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('token') || k.includes('secret') || k.includes('password')
    || k.includes('passphrase') || k.includes('credential') || k.includes('apikey')
    || k.includes('accesskey') || k.includes('privatekey');
}

/** Only plain (Object-prototype) objects are traversed — Dates/class instances pass through intact. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Project an entity into the compliance-event `attributes`, redacting secret
 * VALUES while preserving everything the compliance engine actually evaluates.
 *
 * Strategy (b) — redact-in-place, keys preserved. The compliance rule engine
 * traverses `props` deeply (rules reference paths like
 * `props.stages[].steps[].plugin.field` and computed `$count(props.stages)` /
 * `$keys(env)` — see api/compliance/src/engine/rule-operators.ts and its tests).
 * It reads secret maps ONLY by key (keys/count/presence), never by value. So we
 * walk the row and, for every nested `env`/`buildArgs` map, keep its KEYS but
 * redact each value; scalar secret fields (source `token`, passwords, …) are
 * replaced outright. Structure and non-secret data are preserved so rule
 * evaluation is unchanged, while plaintext secrets never reach Redis or the
 * compliance service.
 */
export function toComplianceAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toComplianceAttributes);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_MAP_KEYS.has(k) && isPlainObject(v)) {
        // Preserve keys (compliance reads $keys/$count/presence), redact values.
        out[k] = Object.fromEntries(Object.keys(v).map((mk) => [mk, REDACTED]));
      } else if (isSecretScalarKey(k) && typeof v === 'string') {
        out[k] = REDACTED;
      } else {
        out[k] = toComplianceAttributes(v);
      }
    }
    return out;
  }
  return value; // primitives, Date, null — untouched
}

/** Pipeline CRUD service with multi-tenant access control. */
export class PipelineService extends CrudService<
  Pipeline,
  PipelineFilter,
  PipelineInsert,
  PipelineUpdate
> {
  protected get schema(): PgTable {
    return schema.pipeline as PgTable;
  }

  protected buildConditions(filter: Partial<PipelineFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    // Thread `parentOrgId` so a team org's reads are widened to its parent's
    // public pipelines (org → team hierarchy), matching the plugin/template
    // builders. Dropping it here meant the base CrudService's
    // find/findPaginated/findById calls silently lost the widening (and a read
    // passed parentOrgId flipped to sysadmin RLS bypass while the WHERE ignored
    // the widen). No-op for root orgs (claim absent).
    return buildPipelineConditions(filter, orgId, parentOrgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const sortableColumns: Record<string, AnyColumn> = {
      id: schema.pipeline.id,
      project: schema.pipeline.project,
      organization: schema.pipeline.organization,
      pipelineName: schema.pipeline.pipelineName,
      createdAt: schema.pipeline.createdAt,
      updatedAt: schema.pipeline.updatedAt,
      isActive: schema.pipeline.isActive,
      isDefault: schema.pipeline.isDefault,
    };

    return sortableColumns[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn {
    return schema.pipeline.project;
  }

  // setDefault scopes clear-others by this column against the tenant context's
  // orgId (a UUID). It must be the `orgId` tenant column — the `organization`
  // display-name column would never match the UUID, so old defaults wouldn't be
  // cleared (leaving multiple defaults per project/org).
  protected getOrgColumn(): AnyColumn {
    return schema.pipeline.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId];
  }

  // -- Cached reads -----------------------------------------------------------

  /** findById with server-side cache (keyed by orgId[:p:parentOrgId]:id). The
   *  parent segment keeps a team's parent-widened read from colliding with the
   *  own-org-only read under the same orgId (mirrors plugin-service). */
  async findById(id: string, orgId?: string, parentOrgId?: string): Promise<Pipeline | null> {
    // Skip caching for anonymous reads: cached entries from an authed caller
    // could leak across a visibility flip (private → public or vice versa),
    // and the anon path bypasses the orgId scoping the cache key relies on.
    if (!orgId) return super.findById(id, orgId, parentOrgId);
    const cacheKey = `${orgId}${parentOrgId ? `:p:${parentOrgId}` : ''}:id:${id}`;
    return pipelineCache.getOrSet(cacheKey, () => super.findById(id, orgId, parentOrgId));
  }

  /**
   * Batched sibling of {@link findById}: fetch many pipelines by id in a single
   * query with the same access-control scoping. Bulk routes use this instead of
   * `Promise.all(ids.map(findById))` (an N+1 round-trip). Not cached — a bulk
   * read would thrash the per-id cache; returns only the rows visible to `orgId`
   * (own org + public), soft-deleted rows excluded, matching findById.
   */
  async findByIds(ids: string[], orgId?: string, parentOrgId?: string): Promise<Pipeline[]> {
    if (ids.length === 0) return [];
    const conditions = this.buildConditions({} as Partial<PipelineFilter>, orgId, parentOrgId);
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.pipeline)
      .where(and(inArray(schema.pipeline.id, ids), ...conditions))
      .then((rows) => rows as unknown as Pipeline[]));
  }

  // -- Lifecycle hooks — emit events + invalidate cache ---------------------

  /**
   * A PUBLIC pipeline (including the system org's shared samples) is cached
   * under EVERY viewing org's key (`<viewerOrg>:id:<id>`), but a mutation only
   * ever runs under the owner's tenant — so clearing just `${ownerOrg}:*` leaves
   * stale copies in every other org's cache. When the row is cross-org-visible,
   * also drop this id across all orgs. (findVisibleToOrg is uncached, so only
   * the per-id findById cache needs the cross-org sweep.)
   */
  private async invalidateSharedReadCaches(id: string, accessModifier?: string): Promise<void> {
    if (accessModifier === AccessModifier.PUBLIC) {
      await pipelineCache.invalidatePattern(`*:id:${id}`);
    }
  }

  private async invalidateAndEmit(eventType: 'created' | 'updated' | 'deleted', id: string, entity: Pipeline, userId: string): Promise<void> {
    await pipelineCache.invalidatePattern(`${entity.orgId}:*`);
    await this.invalidateSharedReadCaches(id, entity.accessModifier);
    // Carry the owning org's parent (when the mutation ran under a team's tenant
    // context) so async compliance eval sees the same parent `propagateToChildren`
    // rules the live path does. Only trust the context parent when its org matches
    // the entity's — a cross-org mutation must not inherit the caller's parent.
    const tenant = getTenantContext();
    const parentOrgId = tenant?.orgId === entity.orgId ? tenant?.parentOrgId : undefined;
    // Project to compliance-safe attributes: the pipeline row's `props` embeds
    // secret VALUES (nested env/buildArgs maps, source tokens) that must never
    // land in Redis / travel to the compliance service. See
    // toComplianceAttributes — keys/structure preserved for rule evaluation,
    // secret values redacted.
    const attributes = toComplianceAttributes(entity) as Record<string, unknown>;
    entityEvents.emit({ eventType, target: 'pipeline', entityId: id, orgId: entity.orgId, parentOrgId, userId, timestamp: new Date(), attributes });
  }

  protected async onAfterCreate(entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('created', entity.id, entity, userId);
  }

  protected async onAfterUpdate(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('updated', id, entity, userId);
  }

  protected async onAfterDelete(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('deleted', id, entity, userId);
  }

  /** A restored pipeline re-enters the live catalog, so it must be re-evaluated
   *  for compliance and its caches invalidated — symmetric with delete. Emitted
   *  as 'updated' (the entity keeps its id/history) so the compliance subscriber
   *  re-checks it rather than treating it as gone. */
  protected async onAfterRestore(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('updated', id, entity, userId);
  }

  /**
   * Build the `ON CONFLICT ... DO UPDATE` set for the default-upsert. Spreading
   * the whole insert `data` here would overwrite immutable columns on the update
   * branch — `createdBy`/`createdAt` would be reset to the current caller/time
   * (rewriting provenance on every re-create) and `id` must never change — so
   * strip those and write only mutable columns plus the fresh default/active
   * flags, the undelete, and the update stamps.
   *
   * `ownerId`/`ownerType` are stripped for the same provenance reason: a re-create
   * of an existing default must not silently transfer catalog ownership to whoever
   * re-ran it. Other catalog metadata (lifecycle/criticality/labels/links) stays in
   * `mutable` so a re-create can legitimately refresh it.
   */
  private buildDefaultConflictSet(data: PipelineInsert, userId: string): Record<string, unknown> {
    const { id: _id, createdAt: _createdAt, createdBy: _createdBy, ownerId: _ownerId, ownerType: _ownerType, ...mutable } = data as Record<string, unknown>;
    return {
      ...mutable,
      isDefault: true,
      isActive: true,
      deletedAt: null,
      deletedBy: null,
      updatedAt: new Date(),
      updatedBy: userId,
    };
  }

  /** Atomically create a pipeline as the default for a project (clears existing defaults). */
  async createAsDefault(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
  ): Promise<Pipeline> {
    // orgId is structurally optional on PipelineInsert but is required here —
    // the FOR UPDATE lock + clear-other-defaults UPDATE both predicate on it
    // (C23 fix). Refuse early instead of silently treating undefined as a
    // wildcard, which would risk clearing defaults across orgs.
    if (!data.orgId) {
      throw new Error('createAsDefault requires data.orgId');
    }
    const orgId = data.orgId;
    return withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM ${schema.pipeline}
            WHERE ${schema.pipeline.project} = ${project}
              AND ${schema.pipeline.organization} = ${organization}
              AND ${schema.pipeline.orgId} = ${orgId}
              AND ${schema.pipeline.isDefault} = true
            FOR UPDATE`,
      );

      await tx
        .update(schema.pipeline)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(
          and(
            eq(schema.pipeline.project, project),
            eq(schema.pipeline.organization, organization),
            eq(schema.pipeline.orgId, orgId),
            eq(schema.pipeline.isDefault, true),
          ),
        );

      const [result] = await tx
        .insert(schema.pipeline)
        .values({ ...data, isDefault: true, isActive: true })
        .onConflictDoUpdate({
          target: [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId],
          set: this.buildDefaultConflictSet(data, userId) as any,
        })
        .returning();

      const pipeline = result as unknown as Pipeline;
      await pipelineCache.invalidatePattern(`${data.orgId}:*`);
      await this.invalidateSharedReadCaches(pipeline.id, pipeline.accessModifier);
      return pipeline;
    });
  }

  /**
   * Like {@link createAsDefault}, but also reports whether the row was inserted
   * (new) or updated (existing). Uses Postgres's `xmax = 0` returning trick:
   * `xmax` is 0 on fresh inserts and non-zero on rows touched by the
   * onConflictDoUpdate path. Used by bulk-create to split the response into
   * `created` vs `updated` counts.
   */
  async createAsDefaultReportInserted(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
  ): Promise<{ pipeline: Pipeline; inserted: boolean }> {
    // Same orgId requirement as createAsDefault — see that function for rationale.
    if (!data.orgId) {
      throw new Error('createAsDefaultReportInserted requires data.orgId');
    }
    const orgId = data.orgId;
    return withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM ${schema.pipeline}
            WHERE ${schema.pipeline.project} = ${project}
              AND ${schema.pipeline.organization} = ${organization}
              AND ${schema.pipeline.orgId} = ${orgId}
              AND ${schema.pipeline.isDefault} = true
            FOR UPDATE`,
      );

      await tx
        .update(schema.pipeline)
        .set({ isDefault: false, updatedAt: new Date(), updatedBy: userId })
        .where(
          and(
            eq(schema.pipeline.project, project),
            eq(schema.pipeline.organization, organization),
            eq(schema.pipeline.orgId, orgId),
            eq(schema.pipeline.isDefault, true),
          ),
        );

      // Build the upsert via Drizzle for typesafe param binding, then ask for
      // every column plus `(xmax = 0)::int AS inserted` in the RETURNING
      // clause. xmax is 0 only on rows produced by the INSERT branch, so it
      // cleanly distinguishes a fresh create from an ON CONFLICT update.
      const returningCols: Record<string, unknown> = {};
      for (const [key, col] of Object.entries(schema.pipeline)) {
        returningCols[key] = col;
      }
      returningCols.inserted = sql<number>`(xmax = 0)::int`;

      const [upserted] = await tx
        .insert(schema.pipeline)
        .values({ ...data, isDefault: true, isActive: true })
        .onConflictDoUpdate({
          target: [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId],
          set: this.buildDefaultConflictSet(data, userId) as any,
        })
        .returning(returningCols as any);

      const { inserted: insertedFlag, ...rest } = upserted as Record<string, unknown> & { inserted: number };
      const pipeline = rest as unknown as Pipeline;
      const inserted = insertedFlag === 1;

      await pipelineCache.invalidatePattern(`${data.orgId}:*`);
      await this.invalidateSharedReadCaches(pipeline.id, pipeline.accessModifier);
      return { pipeline, inserted };
    });
  }
}

export const pipelineService = new PipelineService();
