// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { NotFoundError, createLogger } from '@pipeline-builder/api-core';
import { SQL, eq, and, asc, desc, sql, inArray, getTableColumns } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { withTenantTx, runWithTenantContext, getTenantContext } from '../database/tenancy.js';

/** Pagination defaults — read from env to match CoreConstants in pipeline-core. */
const DEFAULT_PAGE_LIMIT = parseInt(process.env.DEFAULT_PAGE_LIMIT || '100', 10);
const MAX_PAGE_LIMIT = parseInt(process.env.MAX_PAGE_LIMIT || '1000', 10);

/**
 * Cast Drizzle query results to a typed array.
 * Drizzle's generic return type (`PgSelectBase<...>`) doesn't narrow to our
 * entity generics, so an explicit cast is needed. Centralised here so every
 * call-site stays one-liner clean and the cast is documented in one place.
 */
export function drizzleRows<T>(rows: unknown): T[] {
  return rows as T[];
}

/** Cast a Drizzle aggregate result to extract `[{ count: number }]`. */
export function drizzleCount(rows: unknown): [{ count: number }] {
  return rows as [{ count: number }];
}

/** The Drizzle transaction object handed to `withTenantTx` callbacks. Passed to
 *  `onBeforePurge` so a subclass's dependent teardown runs in the SAME purge
 *  transaction (atomic with the parent DELETE), not a fresh connection. */
export type CrudTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/**
 * Base interface for entities with common fields
 */
export interface BaseEntity {
  id: string;
  orgId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  [key: string]: unknown;
}

/**
 * Pagination and sorting options
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** When true, runs a separate COUNT(*) query to include exact total. Default: false. */
  includeTotal?: boolean;
  /** Cursor-based pagination: fetch rows after this cursor value (uses sortBy column). */
  cursor?: string;
  /** Sparse fieldset: column names to select. Returns all columns when omitted. */
  fields?: string[];
}

/**
 * Paginated result with metadata
 */
export interface PaginatedResult<T> {
  data: T[];
  /** Total count of matching entities. Only present when includeTotal is true. */
  total?: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Cursor pointing to the last item, for cursor-based pagination. */
  nextCursor?: string;
}

/**
 * Abstract CRUD service with multi-tenant access control and pagination.
 *
 * Subclasses bind to a specific Drizzle table by implementing `schema`,
 * `buildConditions`, `getSortColumn`, and the org/project-column accessors.
 *
 * @typeParam TEntity - Entity type extending BaseEntity
 * @typeParam TFilter - Filter type for query parameters
 * @typeParam TInsert - Insert DTO type
 * @typeParam TUpdate - Update DTO type
 *
 * **A note on the type casts.** Drizzle's row types are inferred from
 * `pgTable(...)` and don't generically narrow through the abstract `schema`
 * getter, so the base class casts query results to `TEntity` and back. The
 * cast is *not* a runtime safety guarantee — it relies on each subclass
 * passing the matching entity type. Org-scoping is enforced by every
 * subclass's `buildConditions` injecting `WHERE org_id = $1`; this class
 * does not add that filter itself.
 *
 * **Error policy.** Errors propagate up to the route-level handler
 * (`withRoute`); no catch-and-swallow here.
 *
 * @example
 * ```typescript
 * class PipelineService extends CrudService<Pipeline, PipelineFilter, PipelineInsert, PipelineUpdate> {
 *   protected get schema() { return schema.pipeline; }
 *   protected buildConditions(filter, orgId) { return buildPipelineConditions(filter, orgId); }
 *   protected getSortColumn(sortBy) { return sortColumnMap[sortBy] ?? null; }
 *   protected getProjectColumn() { return schema.pipeline.project; }
 *   protected getOrgColumn() { return schema.pipeline.orgId; }
 * }
 * ```
 */
/** Structural view of the subclass table's columns the base class touches
 *  directly. `id`/`isActive`/`isDefault` are always present on a CRUD entity;
 *  `accessModifier` only on public-visibility entities; the index signature
 *  covers dynamic (sparse-fieldset) column access. */
interface CrudColumns {
  id: AnyColumn;
  isActive: AnyColumn;
  isDefault: AnyColumn;
  accessModifier?: AnyColumn;
  // Soft-delete lifecycle columns (present on tombstone-bearing entities only;
  // `restore`/`purgeExpired` are no-ops when absent).
  deletedAt?: AnyColumn;
  purgeAfter?: AnyColumn;
  [key: string]: AnyColumn | undefined;
}

/**
 * Retention before a soft-deleted row becomes purge-eligible, shared across
 * every CrudService entity (unified `SOFT_DELETE_RETENTION_DAYS`, default 30d).
 * Stamped into `purge_after` at delete time; the per-service purge sweep hard-
 * deletes tombstones once it has passed. `0` disables purge-deadline stamping.
 */
const SOFT_DELETE_RETENTION_MS = Math.max(0, Number.parseInt(process.env.SOFT_DELETE_RETENTION_DAYS ?? '30', 10) || 0) * 24 * 60 * 60 * 1000;

export abstract class CrudService<
  TEntity extends BaseEntity,
  TFilter,
  TInsert,
  TUpdate,
> {
  /** Drizzle schema table for this entity */
  protected abstract get schema(): PgTable;

  /**
   * Typed column view of {@link schema}. `PgTable` exposes no static columns, so
   * the base class previously reached for `(this.schema as any).id` etc. at each
   * use; centralize that single unavoidable cast here so callers get structured,
   * typed access instead. `accessModifier` is optional (not every entity has it)
   * and the index signature covers dynamic sparse-fieldset column lookup.
   */
  private get cols(): CrudColumns {
    return this.schema as unknown as CrudColumns;
  }

  /**
   * Build SQL conditions for filtering entities.
   * `parentOrgId` (org → team hierarchy) is optional and only honored by
   * services that opt into parent-inherited visibility (e.g. plugins).
   */
  protected abstract buildConditions(filter: Partial<TFilter>, orgId?: string, parentOrgId?: string): SQL[];

  /** Get the schema column for sorting by field name */
  protected abstract getSortColumn(sortBy: string): AnyColumn | null;

  /** Get the project column for setDefault scoping (null if entity has no project scope) */
  protected abstract getProjectColumn(): AnyColumn | null;

  /**
   * Get the tenant org-id column. Used both to scope `setDefault` and to pin
   * every write (update/delete/bulkDelete) to the caller's own org — so it MUST
   * be the tenant `orgId` column, not a display/name column.
   */
  protected abstract getOrgColumn(): AnyColumn;

  /** Get the unique constraint columns for onConflictDoUpdate */
  protected abstract get conflictTarget(): AnyColumn[];

  private readonly _logger = createLogger('crud-service');

  constructor() {
    // Fail fast if a subclass doesn't expose a tenant org column. The write
    // paths (writeConditions / bulkDelete) pin mutations to the caller's own
    // org through it; a missing column would silently drop that guard — a
    // cross-tenant fail-open — so assert its presence up front.
    if (this.getOrgColumn() == null) {
      throw new Error(`${this.constructor.name}: getOrgColumn() must return the tenant org column`);
    }
  }

  /** Build conditions for a single entity by ID.
   *  `parentOrgId` widens visibility to a parent org's public rows (org → team
   *  hierarchy) — same opt-in semantics as `find`/`findPaginated`. Omitted by the
   *  write path (`writeConditions`), which must stay own-org scoped. */
  private idConditions(id: string, orgId?: string, parentOrgId?: string): SQL[] {
    return this.buildConditions({ id } as unknown as Partial<TFilter>, orgId, parentOrgId);
  }

  /**
   * Conditions for a MUTATION (update/delete) of a single entity.
   *
   * `idConditions` reuses the READ access-control clause, which also matches
   * system-org / other-org PUBLIC records — so without an extra ownership pin any
   * tenant could update or soft-delete another org's (or the system org's) public
   * records. AND a strict `orgId === caller` predicate: the read clause's
   * public-OR branch requires `org_id = 'system'`, which then can't be satisfied,
   * leaving only own-org rows. orgId-less (sysadmin) context keeps full access.
   */
  private writeConditions(id: string, orgId?: string): SQL[] {
    const conditions = this.idConditions(id, orgId);
    // Pin the mutation to the caller's own org via the tenant column
    // (getOrgColumn, asserted non-null in the constructor) — consistent with
    // setDefault and without the old silent fail-open when the property was absent.
    if (orgId) conditions.push(eq(this.getOrgColumn(), orgId));
    // Force EXACT id equality on the mutation path. `idConditions` reuses the
    // list-filter clause, whose `buildIdFilter` PREFIX-matches (`id::text LIKE
    // 'val%'`) any non-full-UUID value — so a partial id (`DELETE /x/ab`) would
    // soft-delete/mutate EVERY own-org row whose id starts with `ab` and report
    // touching one. ANDing an exact `id = val` collapses the prefix clause to at
    // most the single exact row; a malformed/partial id then matches nothing
    // (→ 404 via the callers' `if (!deleted)` guard) instead of mass-mutating.
    conditions.push(this.exactIdCondition(id));
    return conditions;
  }

  /** Exact id equality, lower-cased to match `buildIdFilter`'s full-UUID branch.
   *  `schema` is typed `PgTable` (no static `.id`), so cast — same pattern the
   *  sort/default helpers use for column access. */
  private exactIdCondition(id: string): SQL {
    return eq(this.cols.id, String(id).toLowerCase());
  }

  // Lifecycle hooks — override in subclasses to react to mutations
  // These are fire-and-forget: errors are logged but never block the caller.

  /** Called after a new entity is created */
  protected async onAfterCreate(_entity: TEntity, _userId: string): Promise<void> {}

  /** Called after an entity is updated */
  protected async onAfterUpdate(_id: string, _entity: TEntity, _userId: string): Promise<void> {}

  /** Called after an entity is soft-deleted */
  protected async onAfterDelete(_id: string, _entity: TEntity, _userId: string): Promise<void> {}

  /** Called after a soft-deleted entity is restored (undo the delete). Override
   *  for entities whose restore has side-effects (e.g. re-notify). Best-effort. */
  protected async onAfterRestore(_id: string, _entity: TEntity, _userId: string): Promise<void> {}

  /** Called with the ids about to be hard-purged, BEFORE the delete, inside the
   *  purge transaction (`tx`) — a subclass tearing down dependents that lack ON
   *  DELETE CASCADE MUST use `tx` so the teardown is atomic with the parent
   *  DELETE (and can't self-deadlock against its row locks). Throwing aborts that
   *  batch's purge (rows stay tombstoned, retried next tick). */
  protected async onBeforePurge(_ids: string[], _tx: CrudTx): Promise<void> {}

  /** Called after rows are hard-purged, for external side-effects (e.g. plugin
   *  image GC). Best-effort: errors are logged, never block the sweep. */
  protected async onAfterPurge(_ids: string[]): Promise<void> {}

  /** Retention before a soft-deleted row becomes purge-eligible. Defaults to the
   *  shared `SOFT_DELETE_RETENTION_DAYS`; override per entity for a bespoke window. */
  protected get softDeleteRetentionMs(): number {
    return SOFT_DELETE_RETENTION_MS;
  }

  /** The `purge_after` value to stamp on a soft-delete: `now + retention`, or the
   *  spread-friendly empty object when the entity has no `purge_after` column.
   *  `protected` so subclasses with hand-rolled soft-delete paths (e.g.
   *  message-service's thread cascade / sysadmin moderation) stamp it too — an
   *  un-stamped tombstone has NULL `purge_after` and is never hard-purged. */
  protected purgeAfterStamp(now: Date): Record<string, unknown> {
    if (!this.cols.purgeAfter || this.softDeleteRetentionMs <= 0) return {};
    return { purgeAfter: new Date(now.getTime() + this.softDeleteRetentionMs) };
  }

  /**
   * Org → team hierarchy: when a read is widened to a parent org (`parentOrgId`
   * set), the parent's rows are outside the caller's RLS scope, so the read must
   * run under sysadmin context — the access-control WHERE clause (own + parent +
   * system public, built server-side from a trusted JWT claim) is then the
   * authoritative tenancy gate. Without `parentOrgId` it stays RLS-scoped.
   *
   * INVARIANT (why the sysadmin bypass is safe): the WHERE clause is always
   * server-built by `buildConditions(filter, orgId, parentOrgId)` from values
   * derived from the validated JWT (`orgId` = active org, `parentOrgId` = the
   * active org's parent). None of them is a raw user-supplied predicate, so the
   * bypass only ever widens the read to the caller's own subtree + system public
   * rows — it can NOT be steered at an arbitrary org. NOTE: this does remove the
   * RLS backstop for the widened read; a single-GUC `app.org_id` can't express
   * the "own OR parent OR system" set the policy would need, so replacing the
   * bypass would require a tenancy-layer change (e.g. a multi-org RLS policy).
   * Deferred deliberately — do not swap this for a blanket bypass without
   * re-checking the WHERE is still fully server-built.
   */
  private runRead<T>(parentOrgId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return parentOrgId ? runWithTenantContext({ isSuperAdmin: true }, fn) : fn();
  }

  /**
   * Find entities matching filter criteria
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   */
  async find(filter: Partial<TFilter>, orgId?: string, parentOrgId?: string): Promise<TEntity[]> {
    const conditions = this.buildConditions(filter, orgId, parentOrgId);

    return this.runRead(parentOrgId, () => withTenantTx(async (tx) => tx
      .select()
      .from(this.schema)
      .where(and(...conditions)).then(r => drizzleRows<TEntity>(r))));
  }

  /**
   * Find entities with pagination and sorting
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   * @param options - Pagination and sorting options
   */
  async findPaginated(
    filter: Partial<TFilter>,
    orgId?: string,
    options: QueryOptions = {},
    parentOrgId?: string,
  ): Promise<PaginatedResult<TEntity>> {
    const { limit: rawLimit = DEFAULT_PAGE_LIMIT, offset = 0, sortBy, sortOrder = 'asc', includeTotal = false, cursor, fields } = options;
    const limit = Math.min(Math.max(1, rawLimit), MAX_PAGE_LIMIT);

    // Cursor and offset are mutually exclusive — cursor takes precedence
    const useCursor = !!(cursor && sortBy);

    const conditions = this.buildConditions(filter, orgId, parentOrgId);

    // Cursor-based pagination: add WHERE clause for keyset pagination
    if (useCursor) {
      const sortColumn = this.getSortColumn(sortBy);
      if (sortColumn) {
        const op = sortOrder === 'desc'
          ? sql`${sortColumn} < ${cursor}`
          : sql`${sortColumn} > ${cursor}`;
        conditions.push(op);
      }
    }

    // Wrap the whole paginated read (SELECT + optional COUNT) in one
    // tenant tx. Both queries are visibility-scoped by the same RLS policy,
    // and pinning them to a single tx keeps the `app.org_id` GUC stable
    // between them. When widening to a parent org, the whole read runs under
    // sysadmin context (see runRead) so the access-control WHERE is the gate.
    return this.runRead(parentOrgId, () => withTenantTx(async (tx) => {
      // Build SELECT — sparse fieldset when fields are specified. The sortBy
      // column MUST be part of the projection whenever sorting is active: the
      // next cursor is derived from `lastItem[sortBy]` below, so a fields set
      // that omits sortBy would leave the cursor undefined and stall the client
      // on page 1. buildFieldSelect always adds it back (like `id`).
      const selectSpec = fields ? this.buildFieldSelect(fields, sortBy) : undefined;
      let query = selectSpec
        ? tx.select(selectSpec as any).from(this.schema).where(and(...conditions))
        : tx.select().from(this.schema).where(and(...conditions));

      if (sortBy) {
        const sortColumn = this.getSortColumn(sortBy);
        if (sortColumn) {
          query = query.orderBy(sortOrder === 'desc' ? desc(sortColumn) : asc(sortColumn)) as any;
        }
      }

      // Fetch limit+1 to detect hasMore without COUNT(*)
      const effectiveOffset = useCursor ? 0 : offset;
      const rows = await query
        .limit(limit + 1)
        .offset(effectiveOffset).then(r => drizzleRows<TEntity>(r));

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;

      const result: PaginatedResult<TEntity> = { data, limit, offset: effectiveOffset, hasMore };

      // Provide next cursor from last item's sort column value
      if (data.length > 0 && sortBy) {
        const lastItem = data[data.length - 1] as Record<string, unknown>;
        const cursorValue = lastItem[sortBy];
        if (cursorValue !== undefined) {
          result.nextCursor = cursorValue instanceof Date ? cursorValue.toISOString() : String(cursorValue);
        }
      }

      // Only run the COUNT(*) query when the caller explicitly needs the total.
      // Must include parentOrgId so `total` matches the widened data set.
      if (includeTotal) {
        const baseConditions = this.buildConditions(filter, orgId, parentOrgId);
        const [countResult] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(this.schema)
          .where(and(...baseConditions)).then(r => drizzleCount(r));
        result.total = countResult?.count || 0;
      }

      return result;
    }));
  }

  /**
   * Build a column selection map for sparse fieldsets.
   * Falls back to full select if no matching columns found.
   *
   * `sortBy` (when set) is always folded into the projection even if the caller's
   * `fields` omits it — cursor pagination reads the next cursor from the sort
   * column's value on the last row, so dropping it from the SELECT would yield an
   * undefined cursor and stall paging. Included the same way `id` always is.
   */
  private buildFieldSelect(fields: string[], sortBy?: string): Record<string, unknown> | undefined {
    if (fields.length === 0) return undefined;

    const columns: Record<string, unknown> = {};
    // Always include id for entity identity
    columns.id = this.cols.id;

    for (const field of fields) {
      if (field === 'id') continue; // Already included
      const col = this.cols[field];
      if (col) columns[field] = col;
    }

    // Guarantee the sort column is selectable so the next cursor can be read
    // from the last row (see findPaginated). No-op if already added or unknown.
    if (sortBy && sortBy !== 'id' && !(sortBy in columns)) {
      const sortCol = this.cols[sortBy];
      if (sortCol) columns[sortBy] = sortCol;
    }

    // At minimum we'll have { id }, which is valid
    return columns;
  }

  /**
   * Count entities matching filter criteria
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   * @param parentOrgId - Org → team hierarchy: widen the count to the parent org's
   *   public rows. MUST mirror `find`/`findPaginated`'s widening (same
   *   `buildConditions` args + sysadmin-scoped read via `runRead`) so a paged
   *   list's `total` matches the rows a widened `find()` returns — otherwise the
   *   count omits the parent's rows and reports a narrower total than the data set.
   */
  async count(filter: Partial<TFilter>, orgId?: string, parentOrgId?: string): Promise<number> {
    const conditions = this.buildConditions(filter, orgId, parentOrgId);

    const [result] = await this.runRead(parentOrgId, () => withTenantTx(async (tx) => tx
      .select({ count: sql<number>`count(*)::int` })
      .from(this.schema)
      .where(and(...conditions)).then(r => drizzleCount(r))));

    return result?.count || 0;
  }

  /**
   * Find a single entity by ID
   *
   * @param id - Entity ID
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   * @param parentOrgId - Org → team hierarchy: widen visibility to the parent
   *   org's public rows (so a team can fetch a parent's public entity by id).
   *   Same opt-in + sysadmin-scoped read as `find`/`findPaginated`; the
   *   access-control WHERE clause is the authoritative tenancy gate.
   */
  async findById(id: string, orgId?: string, parentOrgId?: string): Promise<TEntity | null> {
    const conditions = this.idConditions(id, orgId, parentOrgId);
    // Exact id — `findById` means THE row with this id, not a prefix match. The
    // shared `buildIdFilter` prefix-matches non-full-UUID values (a list-search
    // feature), which here would return an arbitrary first prefix hit for a
    // partial id; pin it to exact so a malformed id returns null.
    conditions.push(this.exactIdCondition(id));

    const results = await this.runRead(parentOrgId, () => withTenantTx(async (tx) => tx
      .select()
      .from(this.schema)
      .where(and(...conditions))
      .limit(1).then(r => drizzleRows<TEntity>(r))));

    return results[0] || null;
  }

  // Mutation operations

  /**
   * Defense-in-depth tenant stamp. RLS is in owner-bypass mode, so the app layer
   * is the only tenant gate on writes. A NON-sysadmin caller may only write into
   * its OWN org, so pin the row to the trusted tenant-context org.
   *
   * The stamp fires whenever the payload's `orgId` differs from the context org —
   * which covers BOTH a forged/mismatched `data.orgId` AND an ABSENT one. The
   * absent case is the important tenant-boundary fix: the `org_id` column DEFAULTs
   * to `SYSTEM_ORG_ID` (schema/pipeline.ts, schema/plugin.ts), so an insert that
   * omits `orgId` would otherwise land the tenant's row in the public system
   * catalog — a cross-tenant fail-open. Always injecting `ctx.orgId` closes it.
   *
   * Sysadmin (and out-of-context worker/system paths, where `getTenantContext()`
   * is undefined) keep the supplied org, matching the RLS policy
   * `current_is_sysadmin() OR org_id = current_org_id()`.
   */
  protected enforceOrgId(data: TInsert): TInsert {
    const ctx = getTenantContext();
    const d = data as Record<string, unknown>;
    if (ctx && !ctx.isSuperAdmin && ctx.orgId && d.orgId !== ctx.orgId) {
      // Distinguish the two cases that reach here so the log stays useful and
      // quiet: a PRESENT-but-mismatched `orgId` is an actual override attempt
      // (warn), while an ABSENT `orgId` is the common normal-write path that just
      // needs the default stamp (debug) — logging that at warn floods the log on
      // every write that omits orgId.
      const meta = { supplied: 'orgId' in d ? d.orgId : undefined, enforced: ctx.orgId };
      if ('orgId' in d) {
        this._logger.warn('CrudService: overriding mismatched org on write', meta);
      } else {
        this._logger.debug('CrudService: stamping tenant-context org on write', meta);
      }
      return { ...d, orgId: ctx.orgId } as TInsert;
    }
    return data;
  }

  /**
   * Create a new entity
   */
  async create(data: TInsert, userId: string): Promise<TEntity> {
    const safeData = this.enforceOrgId(data);
    const [created] = await withTenantTx(async (tx) => tx
      .insert(this.schema)
      .values({
        ...safeData,
        createdBy: userId || 'system',
        updatedBy: userId || 'system',
      } as any)
      .onConflictDoUpdate({
        target: this.conflictTarget as any,
        set: {
          ...safeData,
          // RESURRECT on re-create: `delete` soft-deletes (isActive=false + deletedAt/
          // deletedBy set), but the unique constraint keeps the tombstoned row, so a
          // re-create with the same conflict key lands here. Without resetting these,
          // the row's body updates but it stays soft-deleted and never reappears
          // (reads default to isActive=true). Matches the pipeline/plugin overrides.
          isActive: true,
          deletedAt: null,
          deletedBy: null,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any,
      })
      .returning().then(r => drizzleRows<TEntity>(r)));

    // Awaited intentionally: cache invalidation happens in the hook, and a
    // fire-and-forget pattern lets a subsequent read inside the same request
    // return the stale pre-write entry. The hook is expected to be fast
    // (single Redis op); slow hooks should run their own background work.
    try {
      await this.onAfterCreate(created, userId);
    } catch (err) {
      this._logger.warn('Lifecycle hook failed', { error: String(err) });
    }

    return created;
  }

  /**
   * Update an existing entity
   */
  async update(
    id: string,
    data: Partial<TUpdate>,
    orgId: string,
    userId: string,
  ): Promise<TEntity | null> {
    const conditions = this.writeConditions(id, orgId);

    // Scrub a caller-supplied `orgId` in the update payload (as create does): the
    // WHERE only pins which rows you can TARGET, not what you can set — without this
    // a tenant could re-home a row it owns into another org via `data.orgId`.
    const safeData = this.enforceOrgId(data as unknown as TInsert) as unknown as Partial<TUpdate>;

    const [updated] = await withTenantTx(async (tx) => tx
      .update(this.schema)
      .set({
        ...safeData,
        updatedAt: new Date(),
        updatedBy: userId || 'system',
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r)));

    if (updated) {
      try {
        await this.onAfterUpdate(id, updated, userId);
      } catch (err) {
        this._logger.warn('Lifecycle hook failed', { error: String(err) });
      }
    }

    return updated || null;
  }

  /**
   * Delete an entity (soft delete by setting isActive = false)
   */
  async delete(id: string, orgId: string, userId: string): Promise<TEntity | null> {
    const conditions = this.writeConditions(id, orgId);
    const now = new Date();

    const [deleted] = await withTenantTx(async (tx) => tx
      .update(this.schema)
      .set({
        isActive: false,
        updatedAt: now,
        updatedBy: userId || 'system',
        deletedAt: now,
        deletedBy: userId || 'system',
        // Stamp the purge deadline so the retention sweep can hard-delete later.
        ...this.purgeAfterStamp(now),
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r)));

    if (deleted) {
      try {
        await this.onAfterDelete(id, deleted, userId);
      } catch (err) {
        this._logger.warn('Lifecycle hook failed', { error: String(err) });
      }
    }

    return deleted || null;
  }

  /**
   * Set an entity as the default for a project/organization scope.
   * Marks all other entities as non-default, then sets the specified entity.
   * Uses a transaction to ensure atomicity.
   */
  async setDefault(
    project: string,
    org: string,
    id: string,
    userId: string,
  ): Promise<TEntity> {
    // A non-sysadmin may only flip defaults within its OWN org — pin the scope to
    // the trusted tenant context so a forwarded `org` arg can't touch another
    // tenant's defaults (RLS is in owner-bypass mode; this is the gate).
    const ctx = getTenantContext();
    if (ctx && !ctx.isSuperAdmin && ctx.orgId) org = ctx.orgId;
    return withTenantTx(async (tx) => {
      const orgColumn = this.getOrgColumn();
      const projectColumn = this.getProjectColumn();

      // Build scoping conditions for clearing defaults
      const scopeConditions = [
        eq(orgColumn, org),
        eq(this.cols.isDefault, true),
      ];
      if (projectColumn) {
        scopeConditions.push(eq(projectColumn, project));
      }

      // Lock existing defaults with FOR UPDATE to prevent concurrent setDefault races
      await tx.execute(
        sql`SELECT id FROM ${this.schema}
            WHERE ${orgColumn} = ${org}
              AND ${this.cols.isDefault} = true
            ${projectColumn ? sql`AND ${projectColumn} = ${project}` : sql``}
            FOR UPDATE`,
      );

      // Mark all entities in scope as non-default
      await tx
        .update(this.schema)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any)
        .where(and(...scopeConditions));

      // Set the specified entity as default. Guard against promoting a
      // soft-deleted row (isActive = true) — a deleted entity must never become
      // the active default — and pin the id with the same lowercased
      // exactIdCondition the mutation paths use (the raw `eq(cols.id, id)` here
      // skipped the lower-casing that `buildIdFilter`/`writeConditions` apply,
      // so a mixed-case id could miss its row). A non-match → NotFoundError below.
      const [updated] = await tx
        .update(this.schema)
        .set({
          isDefault: true,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any)
        .where(
          and(
            this.exactIdCondition(id),
            eq(orgColumn, org),
            eq(this.cols.isActive, true),
          ),
        )
        .returning().then(r => drizzleRows<TEntity>(r));

      if (!updated) {
        throw new NotFoundError(`Entity with id ${id} not found`);
      }

      return updated;
    });
  }

  /**
   * Update multiple entities matching filter
   */
  async updateMany(
    filter: Partial<TFilter>,
    data: Partial<TUpdate>,
    orgId: string,
    userId: string,
  ): Promise<TEntity[]> {
    const conditions = this.buildConditions(filter, orgId);
    // Own-org write-pin: buildConditions also matches system/other-org PUBLIC
    // rows, so without the strict orgId pin a filter-based update could mutate
    // shared (or another tenant's public) records. Mirror update/delete/
    // bulkDelete. (See writeConditions.) An orgId-less (sysadmin) context keeps
    // full access.
    if (orgId) conditions.push(eq(this.getOrgColumn(), orgId));

    // Scrub a caller-supplied orgId (see update()) so a filter-based update can't
    // re-home rows into another tenant.
    const safeData = this.enforceOrgId(data as unknown as TInsert) as unknown as Partial<TUpdate>;

    return withTenantTx(async (tx) => tx
      .update(this.schema)
      .set({
        ...safeData,
        updatedAt: new Date(),
        updatedBy: userId || 'system',
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r)));
  }

  /**
   * Create multiple entities in a single batch insert.
   * Uses upsert (onConflictDoUpdate) — all rows are inserted in one query per chunk.
   * Chunks of 100 to stay within PostgreSQL parameter limits.
   */
  /**
   * Build the `onConflictDoUpdate` SET for a bulk upsert. Unlike a single-row
   * create (which can spread the one row's data), a batched insert has many rows,
   * so each updatable column is written from `excluded.*` (the would-be-inserted
   * value) — otherwise an existing row's fields are silently discarded and only
   * timestamps bump. Skips identity/immutable (`id`, `createdAt`, `createdBy`)
   * and the conflict-target columns; `updatedAt`/`updatedBy` get the fresh values.
   */
  private buildBulkUpsertSet(now: Date, user: string): Record<string, unknown> {
    const conflictNames = new Set(this.conflictTarget.map((c) => (c as unknown as { name: string }).name));
    const set: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(getTableColumns(this.schema))) {
      const name = (col as unknown as { name: string }).name;
      if (key === 'id' || key === 'createdAt' || key === 'createdBy' || conflictNames.has(name)) continue;
      if (key === 'updatedAt') { set[key] = now; continue; }
      if (key === 'updatedBy') { set[key] = user; continue; }
      set[key] = sql`excluded.${sql.identifier(name)}`;
    }
    // RESURRECT on bulk re-create (matches the single-row create): reset the
    // soft-delete columns explicitly rather than rely on `excluded.*` + column
    // defaults, so a re-created same-key row is always reactivated, not left
    // tombstoned. All CrudService entities carry these (delete() sets all three).
    set.isActive = true;
    set.deletedAt = null;
    set.deletedBy = null;
    return set;
  }

  async bulkCreate(items: TInsert[], userId: string): Promise<TEntity[]> {
    if (items.length === 0) return [];

    const CHUNK_SIZE = 100;
    const now = new Date();
    const user = userId || 'system';
    const conflictSet = this.buildBulkUpsertSet(now, user);

    const results = await withTenantTx(async (tx) => {
      const allCreated: TEntity[] = [];

      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        const chunk = items.slice(i, i + CHUNK_SIZE);
        const values = chunk.map(data => ({
          ...this.enforceOrgId(data),
          createdBy: user,
          updatedBy: user,
        } as any));

        const created = await tx
          .insert(this.schema)
          .values(values)
          .onConflictDoUpdate({
            target: this.conflictTarget as any,
            set: conflictSet as any,
          })
          .returning().then(r => drizzleRows<TEntity>(r));

        allCreated.push(...created);
      }

      return allCreated;
    });

    // Run hooks in parallel but await all before returning so a subsequent
    // read in the same request sees a coherent post-write view.
    await Promise.all(
      results.map(entity =>
        this.onAfterCreate(entity, userId).catch(err =>
          this._logger.warn('Lifecycle hook failed', { error: String(err) }),
        ),
      ),
    );

    return results;
  }

  /**
   * Soft-delete multiple entities by IDs in a single batch operation.
   */
  async bulkDelete(
    ids: string[],
    orgId: string,
    userId: string,
    /** When true, only PRIVATE records are deleted — mirrors the single-delete
     *  `requirePublicAccess` gate so a non-sysadmin can't bulk-delete public
     *  (shared/sysadmin-managed) records. No-op for entities without an
     *  `accessModifier` column. Callers pass `!isSystemAdmin(req)`. */
    restrictToPrivate = false,
  ): Promise<TEntity[]> {
    if (ids.length === 0) return [];

    const now = new Date();
    const user = userId || 'system';
    // Owner-scope the bulk soft-delete: buildConditions also matches system/other
    // -org PUBLIC rows, so without the strict orgId pin a tenant could delete
    // shared records by id. (See writeConditions.)
    const accessCol = this.cols.accessModifier;
    const conditions = [
      inArray(this.cols.id, ids),
      ...this.buildConditions({} as Partial<TFilter>, orgId),
      // Tenant column (getOrgColumn, asserted non-null) — consistent with
      // writeConditions; no silent fail-open when the property is absent.
      ...(orgId ? [eq(this.getOrgColumn(), orgId)] : []),
      ...(restrictToPrivate && accessCol ? [eq(accessCol, 'private')] : []),
    ];

    const deleted = await withTenantTx(async (tx) => tx
      .update(this.schema)
      .set({
        isActive: false,
        updatedAt: now,
        updatedBy: user,
        deletedAt: now,
        deletedBy: user,
        // Stamp the purge deadline so the retention sweep can hard-delete later.
        ...this.purgeAfterStamp(now),
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r)));

    await Promise.all(
      deleted.map(entity =>
        this.onAfterDelete(entity.id, entity, userId).catch(err =>
          this._logger.warn('Lifecycle hook failed', { error: String(err) }),
        ),
      ),
    );

    return deleted;
  }

  /**
   * Restore a soft-deleted (tombstoned) entity: clear `isActive`/`deletedAt`/
   * `deletedBy`/`purgeAfter` so it reappears in normal reads.
   *
   * Matches ONLY a genuine tombstone — `isActive = false` AND `deletedAt IS NOT
   * NULL` — so a merely *deactivated* row (isActive=false, no deletedAt) is never
   * silently "restored". Pinned to the caller's own org (orgId-less sysadmin
   * context spans orgs, matching delete/update). Returns null when there is no
   * such tombstone (already active, purged, or unknown) so the route can 404.
   * A unique-key collision (a live row already holds the key) surfaces as the
   * driver's unique-violation for the route to map to 409 — in practice the
   * tombstone IS the key holder, so this is defensive.
   */
  /** Conditions matching a GENUINE tombstone (`isActive=false` AND `deletedAt IS
   *  NOT NULL`), optionally pinned to `id` and/or `orgId`. Single source of truth
   *  for restore/findDeletedById/findDeleted so the "what is a tombstone" rule
   *  lives in one place. */
  private tombstoneConditions(orgId?: string, id?: string): SQL[] {
    const conditions: SQL[] = [
      eq(this.cols.isActive, false),
      sql`${this.cols.deletedAt} IS NOT NULL`,
    ];
    if (id !== undefined) conditions.unshift(this.exactIdCondition(id));
    if (orgId) conditions.push(eq(this.getOrgColumn(), orgId));
    return conditions;
  }

  async restore(id: string, orgId: string, userId: string): Promise<TEntity | null> {
    if (!this.cols.deletedAt) return null; // entity has no soft-delete lifecycle
    const conditions = this.tombstoneConditions(orgId, id);

    const [restored] = await withTenantTx(async (tx) => tx
      .update(this.schema)
      .set({
        isActive: true,
        updatedAt: new Date(),
        updatedBy: userId || 'system',
        deletedAt: null,
        deletedBy: null,
        ...(this.cols.purgeAfter ? { purgeAfter: null } : {}),
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r)));

    if (restored) {
      try {
        await this.onAfterRestore(id, restored, userId);
      } catch (err) {
        this._logger.warn('Lifecycle hook failed', { error: String(err) });
      }
    }

    return restored || null;
  }

  /**
   * Read a soft-deleted entity by id (the inverse of the default `isActive=true`
   * reads) — used by restore routes to load the tombstone for access-control
   * gating before restoring. Returns null unless the row exists AND is a genuine
   * tombstone (`isActive=false` + `deletedAt IS NOT NULL`).
   */
  async findDeletedById(id: string, orgId?: string): Promise<TEntity | null> {
    if (!this.cols.deletedAt) return null;
    const conditions = this.tombstoneConditions(orgId, id);

    const results = await withTenantTx(async (tx) => tx
      .select()
      .from(this.schema)
      .where(and(...conditions))
      .limit(1).then(r => drizzleRows<TEntity>(r)));

    return results[0] || null;
  }

  /**
   * List an org's soft-deleted tombstones (`isActive=false` + `deletedAt IS NOT
   * NULL`), most-recently-deleted first — powers the "recently deleted" restore
   * UI. Returns `[]` for entities without a soft-delete lifecycle. `limit` is
   * clamped to [1, 200] to keep the response bounded (the retention sweep hard-
   * deletes old tombstones anyway, so this is a short, self-limiting list).
   */
  async findDeleted(
    orgId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<TEntity[]> {
    if (!this.cols.deletedAt) return [];
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const offset = Math.max(0, opts.offset ?? 0);

    const conditions = this.tombstoneConditions(orgId);

    return withTenantTx(async (tx) => tx
      .select()
      .from(this.schema)
      .where(and(...conditions))
      .orderBy(desc(this.cols.deletedAt!))
      .limit(limit)
      .offset(offset)
      .then(r => drizzleRows<TEntity>(r)));
  }

  /**
   * Hard-delete a batch of tombstones whose purge deadline has passed
   * (`deletedAt IS NOT NULL AND purge_after < now`). Batched (`limit`) so a
   * sweep tick stays bounded; the per-service sweep loops until a tick returns
   * `< limit`. Runs across ALL orgs, so callers MUST invoke it from a sysadmin
   * scope (`runSoftDeletePurge` establishes one). `onBeforePurge(ids, tx)` tears
   * down dependents lacking ON DELETE CASCADE inside the same tx; `onAfterPurge`
   * handles external side-effects.
   * Returns the number of rows purged. No-op (0) for entities without the columns.
   */
  async purgeExpired(now: Date, limit = 500): Promise<number> {
    if (!this.cols.deletedAt || !this.cols.purgeAfter) return 0;

    const purgedIds = await withTenantTx(async (tx) => {
      const doomed = await tx
        // `as any`: cols.id is the base `AnyColumn`, which drizzle's typed
        // select-field map doesn't accept directly (same friction the `.set()`
        // casts elsewhere in this file work around). Result is re-typed below.
        .select({ id: this.cols.id as any })
        .from(this.schema)
        .where(and(sql`${this.cols.deletedAt} IS NOT NULL`, sql`${this.cols.purgeAfter} < ${now}`))
        .limit(limit)
        .then(r => (r as Array<{ id: unknown }>).map(d => String(d.id)));

      if (doomed.length === 0) return [];

      // Dependent teardown must happen inside the same tx so a FK-blocking child
      // can't strand the parent. A throw here aborts this batch (retried next tick).
      await this.onBeforePurge(doomed, tx);

      await tx.delete(this.schema).where(inArray(this.cols.id, doomed));
      return doomed;
    });

    if (purgedIds.length > 0) {
      try {
        await this.onAfterPurge(purgedIds);
      } catch (err) {
        this._logger.warn('Lifecycle hook failed', { error: String(err) });
      }
    }

    return purgedIds.length;
  }
}
