// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import { checkWriteAccess, ConflictError, ErrorCode, ForbiddenError, VISIBILITY_WRITE_REFUSAL, createLogger, entityEvents, createCacheService, errorMessage, toComplianceAttributes } from '@pipeline-builder/api-core';
import type { VisibilityWriteRefusal, WriteAccess } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import {
  CrudService, buildPipelineConditions, closePipelineExposures, getTenantContext, schema, viewerCacheSegment, withTenantTx, withViewerContext, type CrudTx, type PipelineFilter,
} from '@pipeline-builder/pipeline-data';
import { SQL, eq, and, sql, inArray } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { recordPipelineResolution } from '../helpers/plugin-contract-check.js';

const logger = createLogger('pipeline-service');

/**
 * Exposures closed inside a {@link withClosedExposureTally} scope. The closes
 * run in CrudService lifecycle hooks, which return nothing to the route that
 * triggered them — this is how that route learns the count for its audit event.
 */
const closedExposureTally = new AsyncLocalStorage<{ closed: number }>();

/**
 * Run a pipeline delete/purge and report how many plugin vulnerability
 * exposures its lifecycle hooks closed (summed across rows for a bulk delete).
 */
export async function withClosedExposureTally<T>(fn: () => Promise<T>): Promise<{ result: T; exposuresClosed: number }> {
  const tally = { closed: 0 };
  const result = await closedExposureTally.run(tally, fn);
  return { result, exposuresClosed: tally.closed };
}

/**
 * Close a removed pipeline's exposures (`removed`), best-effort: the pipeline
 * write already landed, and a report row that stays open is a reporting defect,
 * not a reason to fail the delete.
 */
async function closeRemovedExposures(pipelineId: string, source?: 'declared' | 'deployed'): Promise<void> {
  try {
    const closed = await closePipelineExposures(pipelineId, 'removed', source ? { source } : {});
    const tally = closedExposureTally.getStore();
    if (tally) tally.closed += closed;
  } catch (err) {
    logger.warn('Exposures of a removed pipeline not closed', { pipelineId, source: source ?? 'all', error: errorMessage(err) });
  }
}

/**
 * Refuse to let a create's ON CONFLICT branch overwrite a row the caller could
 * not modify through PUT/DELETE, or resurrect a tombstone without restore's
 * step-up.
 *
 * The RULE is api-core's `checkWriteAccess` — the same one
 * `requireVisibilityWriteAccess` applies on PUT/DELETE, so the create path can
 * never drift from it. This function adds only what is pipeline's own: the
 * tombstone check (which precedes the gate, so not even a system admin
 * resurrects one implicitly) and the per-verdict message.
 */
function assertMayOverwrite(
  existing: { visibility: string | null; createdBy: string | null; deletedAt: Date | null },
  userId: string,
  access: WriteAccess,
): void {
  if (existing.deletedAt) {
    throw new ConflictError(
      'A deleted pipeline already occupies this project/organization. Restore it or purge it before creating a new one.',
    );
  }
  // KEYED, and tested for `!== 'ok'` rather than switched on. The switch this
  // replaces ended in a bare `case 'ok':` that fell out of the block, so a
  // refusal verdict added to the union would have been treated as permission —
  // on a CREATE path that overwrites someone else's row. Inverted, the only
  // verdict that proceeds is the one that names success, and `Record` over the
  // refusals means a new one cannot compile until it has a message here.
  const verdict = checkWriteAccess(existing, userId, access);
  if (verdict !== 'ok') throw OVERWRITE_REFUSAL[verdict]();
}

/**
 * What each refusal means for a pipeline CREATE that found an existing row.
 *
 * `needs-publish` reuses api-core's shared sentence (the rung is the same
 * everywhere, so the wording should be too); `not-author` is pipeline's own,
 * because the caller is creating rather than editing and "already exists and
 * belongs to another author" is the actionable fact. The error TYPES differ for
 * the same reason — one is an authority problem (403), the other a collision
 * (409).
 */
const OVERWRITE_REFUSAL: Readonly<Record<VisibilityWriteRefusal, () => Error>> = {
  'needs-publish': () => new ForbiddenError(VISIBILITY_WRITE_REFUSAL['needs-publish']),
  'not-author': () => new ConflictError(
    'A pipeline for this project/organization already exists and belongs to another author.',
  ),
};

/** Server-side cache for pipeline reads. */
const pipelineCache = createCacheService('pipeline:', CoreConstants.CACHE_TTL_ENTITY);

export type Pipeline = typeof schema.pipeline.$inferSelect;
export type PipelineInsert = typeof schema.pipeline.$inferInsert;
export type PipelineUpdate = Partial<Omit<Pipeline, 'id' | 'createdAt' | 'createdBy'>>;

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
    //
    // `withViewerContext` stamps the caller so the `private` rung matches the
    // author's own rows. Without it the private branch fails closed for EVERY
    // caller, and an author can't read, update or delete their own pipeline.
    return buildPipelineConditions(withViewerContext(filter), orgId, parentOrgId);
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

    // Own keys only: `sortBy` is client input, and a plain lookup walks the
    // prototype (`?sortBy=constructor` returned a function, not a column).
    return Object.hasOwn(sortableColumns, sortBy) ? sortableColumns[sortBy] : null;
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

  /** findById with server-side cache (keyed by orgId[:p:parentOrgId]:v:viewer:id).
   *  The parent segment keeps a team's parent-widened read from colliding with the
   *  own-org-only read under the same orgId (mirrors plugin-service). */
  async findById(id: string, orgId?: string, parentOrgId?: string): Promise<Pipeline | null> {
    // Skip caching for anonymous reads: cached entries from an authed caller
    // could leak across a visibility flip (private → public or vice versa),
    // and the anon path bypasses the orgId scoping the cache key relies on.
    if (!orgId) return super.findById(id, orgId, parentOrgId);
    // The VIEWER is part of the key because it is part of the answer. The read
    // predicate is `org_id = O AND (visibility <> 'private' OR created_by = V)`,
    // so two members of one org get legitimately different rows for the same id.
    // Keyed on org alone, the author's own `private` pipeline — `props` and all,
    // which carries source tokens and env — was served from cache to everyone
    // else in the org. Super-admins share one bucket: the private rung is lifted
    // for all of them, so their slice is identical.
    const cacheKey = `${orgId}${parentOrgId ? `:p:${parentOrgId}` : ''}:v:${viewerCacheSegment()}:id:${id}`;
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
   * under EVERY viewing org's key (`<viewerOrg>:v:<viewer>:id:<id>`), but a
   * mutation only ever runs under the owner's tenant — so clearing just
   * `${ownerOrg}:*` leaves stale copies in every other org's cache.
   *
   * UNCONDITIONAL, because a `visibility === 'public'` condition would read
   * the row's state AFTER the mutation. A DEMOTION is exactly the case that
   * matters — public → org/private ends with a non-public row, so the sweep
   * would be skipped and every other org would keep serving the copy it had
   * cached while the pipeline was still shared, for the rest of the TTL. A
   * promotion has the mirror problem in reverse. Tracking the previous
   * visibility would work; not needing to know is simpler and cannot be got
   * wrong. Mutations are rare next to reads, so the extra sweep is cheap.
   * (`findVisibleToOrg` is uncached, so only the per-id cache needs this.)
   */
  private async invalidateSharedReadCaches(id: string): Promise<void> {
    await pipelineCache.invalidatePattern(`*:id:${id}`);
  }

  private async invalidateAndEmit(eventType: 'created' | 'updated' | 'deleted', id: string, entity: Pipeline, userId: string): Promise<void> {
    await pipelineCache.invalidatePattern(`${entity.orgId}:*`);
    await this.invalidateSharedReadCaches(id);
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

  /**
   * A soft-deleted pipeline's DECLARED exposures close as `removed`: its config
   * no longer describes anything that will run. Its DEPLOYED exposures stay open
   * — the stack keeps running until it is torn down and deregistered (which
   * closes those).
   */
  protected async onAfterDelete(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('deleted', id, entity, userId);
    await closeRemovedExposures(id, 'declared');
  }

  /**
   * A purged pipeline takes everything keyed by its id with it, in the same
   * transaction. None of these tables has an FK to `pipelines` (they are keyed
   * by the registration / the report, not the row), so without this they
   * outlived the pipeline forever:
   *   - the STEP MANIFEST kept counting as installs / verified use in cross-org
   *     plugin stats, and kept its image digests "referenced" for the `public/*`
   *     GC guard;
   *   - the REGISTRY row (reachable only through a forced purge — see the purge
   *     route) kept mapping a stack's events to a pipeline that no longer exists;
   *   - the RESOLUTION rows kept reporting steps of a pipeline nobody can open;
   *   - the STEP LOOKUPS and SECURITY REPORTS kept answering for it too.
   */
  protected async onBeforePurge(ids: string[], tx: CrudTx): Promise<void> {
    if (ids.length === 0) return;
    await tx.delete(schema.pipelineStepManifest).where(inArray(schema.pipelineStepManifest.pipelineId, ids));
    await tx.delete(schema.pipelineRegistry).where(inArray(schema.pipelineRegistry.pipelineId, ids));
    await tx.delete(schema.pipelinePluginResolution).where(inArray(schema.pipelinePluginResolution.pipelineId, ids));
    // What synth was told per step, and the pipeline's own artifact-scan reports:
    // both name the pipeline, so they go with it.
    await tx.delete(schema.pipelineStepLookup).where(inArray(schema.pipelineStepLookup.pipelineId, ids));
    await tx.delete(schema.pipelineSecurityReport).where(inArray(schema.pipelineSecurityReport.pipelineId, ids));
  }

  /** Every exposure of a purged pipeline — declared and deployed — closes as `removed`. */
  protected async onAfterPurge(ids: string[]): Promise<void> {
    for (const id of ids) await closeRemovedExposures(id);
  }

  /** A restored pipeline re-enters the live catalog, so it must be re-evaluated
   *  for compliance and its caches invalidated — symmetric with delete. Emitted
   *  as 'updated' (the entity keeps its id/history) so the compliance subscriber
   *  re-checks it rather than treating it as gone. Its resolution is recorded
   *  again, which reopens the declared exposures the delete closed (background,
   *  never throws). */
  protected async onAfterRestore(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('updated', id, entity, userId);
    const tenant = getTenantContext();
    void recordPipelineResolution(id, entity.orgId, tenant?.orgId === entity.orgId ? tenant?.parentOrgId : undefined, entity.props);
  }

  /**
   * The pipeline occupying a `(project, organization, org)` slot, INCLUDING a
   * soft-deleted tombstone — `null` when the slot is free.
   *
   * Deliberately bypasses the visibility/soft-delete read predicate: this answers
   * "would a create land here?", and the unique index that decides that is blind
   * to both. A caller that cannot READ the occupying row still needs to be told
   * the slot is taken, which is why only the three slot columns and the row's
   * lifecycle state are returned — never its `props`.
   */
  async findOneBySlot(project: string, organization: string, orgId: string): Promise<
    { id: string; pipelineName: string | null; visibility: string | null; deletedAt: Date | null } | null
  > {
    return withTenantTx(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.pipeline.id,
          pipelineName: schema.pipeline.pipelineName,
          visibility: schema.pipeline.visibility,
          deletedAt: schema.pipeline.deletedAt,
        })
        .from(schema.pipeline)
        .where(
          and(
            eq(schema.pipeline.project, project),
            eq(schema.pipeline.organization, organization),
            eq(schema.pipeline.orgId, orgId),
          ),
        );
      return row ?? null;
    });
  }

  /**
   * Build the `ON CONFLICT ... DO UPDATE` set for the default-upsert. Spreading
   * the whole insert `data` here would overwrite immutable columns on the update
   * branch — `createdBy`/`createdAt` would be reset to the current caller/time
   * (rewriting provenance on every re-create) and `id` must never change — so
   * strip those and write only mutable columns plus the fresh default/active
   * flags and the update stamps. (No undelete: a tombstone is refused before
   * the upsert — see {@link createAsDefaultReportInserted}.)
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
      isActive: data.isActive ?? true,
      updatedAt: new Date(),
      updatedBy: userId,
    };
  }

  /**
   * Create a pipeline as the default for its (project, organization) — or, when
   * that slot is already taken by a LIVE row the caller may write AND
   * `opts.upsert` is set, update it in place. Without `opts.upsert` a taken slot
   * is a {@link ConflictError}, so a plain create can never overwrite a live
   * pipeline's props while reporting success.
   * Reports whether the row was inserted (new) or updated (existing) via
   * Postgres's `xmax = 0` returning trick (`xmax` is 0 on fresh inserts and
   * non-zero on rows touched by the onConflictDoUpdate path), so create and
   * bulk-create can split `created` vs `updated` and refund quota.
   *
   * The `(project, organization, org_id)` unique index is ORG-WIDE and blind to
   * visibility and soft-delete, so the ON CONFLICT branch can land on a row the
   * caller could never touch through PUT/DELETE. Before the upsert, the
   * conflicting row is loaded (locked) and:
   *   - a soft-deleted TOMBSTONE → {@link ConflictError}. Create must not be a
   *     step-up-free back door around `POST /pipelines/:id/restore`; restore or
   *     purge it (both step-up gated) first.
   *   - a live row the caller may not write per the visibility ladder
   *     (`public` needs `pipelines:publish`, `private` is author-only) →
   *     {@link ForbiddenError} / {@link ConflictError}, exactly the verdicts
   *     `requireVisibilityWriteAccess` gives PUT/DELETE.
   * A transaction-scoped advisory lock on (org, project, organization) serializes
   * concurrent creates for the same slot — including the FIRST, when there is no
   * row yet for `FOR UPDATE` to lock — so the check can't be raced.
   */
  async createAsDefaultReportInserted(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
    access: WriteAccess,
    opts: { upsert?: boolean } = {},
  ): Promise<{ pipeline: Pipeline; inserted: boolean }> {
    // orgId is structurally optional on PipelineInsert but is required here —
    // the lock, the conflict lookup and the clear-other-defaults UPDATE all
    // predicate on it. Refuse early instead of treating undefined as a wildcard.
    if (!data.orgId) {
      throw new Error('createAsDefaultReportInserted requires data.orgId');
    }
    const orgId = data.orgId;
    return withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'pipeline:' + orgId + ':' + project + ':' + organization}))`,
      );

      const [existing] = await tx
        .select({
          id: schema.pipeline.id,
          pipelineName: schema.pipeline.pipelineName,
          visibility: schema.pipeline.visibility,
          createdBy: schema.pipeline.createdBy,
          deletedAt: schema.pipeline.deletedAt,
        })
        .from(schema.pipeline)
        .where(
          and(
            eq(schema.pipeline.project, project),
            eq(schema.pipeline.organization, organization),
            eq(schema.pipeline.orgId, orgId),
          ),
        )
        .for('update');
      if (existing) {
        assertMayOverwrite(existing, userId, access);
        // The caller MAY write this row, but a create that silently overwrites it
        // is indistinguishable from a create that made something new: the route
        // returned 201 either way, so a second `create` for the same slot replaced
        // a live pipeline's props and reported success. Overwriting is now opt-in
        // (`?upsert=true`, or PUT against the id below).
        //
        // `project`/`organization` here are NORMALIZED (lowercased, non-alphanumerics
        // to `_`), which is how `My-App` and `my_app` reach the same slot — so the
        // details echo the normalized pair that actually collided, not what was sent.
        if (opts.upsert !== true) {
          throw new ConflictError(
            `A pipeline already exists for project "${project}" in organization "${organization}". `
            + 'Retry with `?upsert=true` to overwrite it, or update it directly with '
            + `PUT /pipelines/${existing.id}.`,
            ErrorCode.CONFLICT,
            {
              pipelineId: existing.id,
              pipelineName: existing.pipelineName,
              normalized: { project, organization },
            },
          );
        }
      }

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
        // `isDefault` is forced: one row per (project, organization, org) slot, so
        // the row in a slot is that slot's default. `isActive` is the caller's
        // (`--no-active` creates a paused pipeline) and defaults to active.
        .values({ ...data, isDefault: true, isActive: data.isActive ?? true })
        .onConflictDoUpdate({
          target: [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId],
          set: this.buildDefaultConflictSet(data, userId) as any,
        })
        .returning(returningCols as any);

      const { inserted: insertedFlag, ...rest } = upserted as Record<string, unknown> & { inserted: number };
      const pipeline = rest as unknown as Pipeline;
      const inserted = insertedFlag === 1;

      await pipelineCache.invalidatePattern(`${data.orgId}:*`);
      await this.invalidateSharedReadCaches(pipeline.id);
      return { pipeline, inserted };
    });
  }
}

export const pipelineService = new PipelineService();
