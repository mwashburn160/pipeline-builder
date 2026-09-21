// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConflictError, NotFoundError, createLogger, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@pipeline-builder/api-core';
import { SQL, eq, and, or, asc, desc, sql, inArray, getTableColumns } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { withTenantTx, runWithTenantContext, getTenantContext } from '../database/tenancy.js';


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
  /**
   * Keyset pagination: the opaque `nextCursor` of the previous page. Continues
   * strictly after that row in (sortBy, id) order; takes precedence over `offset`.
   */
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
  /** Opaque cursor for the next page. Present only when `hasMore`. */
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
 *  `visibility` only on visibility-bearing entities; the index signature
 *  covers dynamic (sparse-fieldset) column access. */
interface CrudColumns {
  id: AnyColumn;
  isActive: AnyColumn;
  isDefault: AnyColumn;
  visibility?: AnyColumn;
  /** Author column — the `private` rung of the visibility ladder is author-only. */
  createdBy?: AnyColumn;
  // Soft-delete lifecycle columns (present on tombstone-bearing entities only;
  // `restore`/`purgeExpired` are no-ops when absent).
  deletedAt?: AnyColumn;
  purgeAfter?: AnyColumn;
  [key: string]: AnyColumn | undefined;
}

/** Projection alias carrying the sort column's exact DB text for the next cursor. */
const CURSOR_SORT_KEY = '__cursorSortKey';

/**
 * Opaque keyset cursor: the last row's sort value as Postgres TEXT (full
 * precision — a JS `Date` would truncate `timestamptz` microseconds to ms, so
 * `created_at > '<ms>'` re-returns or skips rows in the same millisecond) plus
 * its `id` as the tie-breaker.
 */
function encodeCursor(sortText: string | null, id: string): string {
  return Buffer.from(JSON.stringify([sortText, id]), 'utf8').toString('base64url');
}

/** Decode a cursor produced by {@link encodeCursor}; `null` when malformed. */
function decodeCursor(cursor: string): { sortText: string | null; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && (parsed[0] === null || typeof parsed[0] === 'string')
      && typeof parsed[1] === 'string' && parsed[1].length > 0
    ) {
      return { sortText: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres `timestamp[tz]::text` / `date::text` (also accepts ISO-8601). */
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/**
 * Whether `text` can be cast to `column`'s type. A decoded cursor is still
 * client input: a value Postgres can't cast (a non-UUID id, a garbage
 * timestamp) fails the whole query with a 500. Column types this doesn't know
 * (text, varchar, …) accept any string.
 */
function isCastableTo(column: AnyColumn, text: string): boolean {
  const { columnType, dataType } = column;
  const enumValues = (column as { enumValues?: readonly string[] }).enumValues;
  if (columnType === 'PgUUID') return UUID_TEXT.test(text);
  if ((columnType === 'PgEnumColumn' || columnType === 'PgEnumObjectColumn') && enumValues?.length) return enumValues.includes(text);
  if (dataType === 'date' || columnType === 'PgTimestampString' || columnType === 'PgDateString') return TIMESTAMP_TEXT.test(text);
  if (dataType === 'boolean') return text === 'true' || text === 'false';
  if (dataType === 'number' || dataType === 'bigint') return NUMERIC_TEXT.test(text);
  return true;
}

/**
 * Keyset predicate "strictly after (sortText, id)" for `ORDER BY sort <dir>, id <dir>`
 * under Postgres' default null placement (ASC → NULLS LAST, DESC → NULLS FIRST).
 * The text value is bound as a parameter compared against the column, so Postgres
 * casts it back to the column's type at full precision.
 */
function keysetAfter(
  sortColumn: AnyColumn,
  idColumn: AnyColumn,
  sortOrder: 'asc' | 'desc',
  sortText: string | null,
  id: string,
): SQL {
  if (sortColumn === idColumn) {
    return sortOrder === 'desc' ? sql`${idColumn} < ${id}` : sql`${idColumn} > ${id}`;
  }
  if (sortOrder === 'asc') {
    return sortText === null
      ? sql`(${sortColumn} IS NULL AND ${idColumn} > ${id})`
      : sql`(${sortColumn} > ${sortText} OR (${sortColumn} = ${sortText} AND ${idColumn} > ${id}) OR ${sortColumn} IS NULL)`;
  }
  return sortText === null
    ? sql`(${sortColumn} IS NOT NULL OR (${sortColumn} IS NULL AND ${idColumn} < ${id}))`
    : sql`(${sortColumn} < ${sortText} OR (${sortColumn} = ${sortText} AND ${idColumn} < ${id}))`;
}

/**
 * Retention before a soft-deleted row becomes purge-eligible, shared across
 * every CrudService entity (unified `SOFT_DELETE_RETENTION_DAYS`, default 30d).
 * Stamped into `purge_after` at delete time; the per-service purge sweep hard-
 * deletes tombstones once it has passed. `0` disables purge-deadline stamping.
 */
const SOFT_DELETE_RETENTION_MS = Math.max(0, Number.parseInt(process.env.SOFT_DELETE_RETENTION_DAYS ?? '30', 10) || 0) * 24 * 60 * 60 * 1000;

/** The shared soft-delete retention window in ms (`SOFT_DELETE_RETENTION_DAYS`,
 *  default 30d; 0 disables purge-deadline stamping). Exposed so non-CrudService
 *  soft-delete paths (e.g. platform's hand-rolled dashboard/alert services)
 *  stamp `purge_after` with the SAME window the CrudService entities use. */
export function softDeleteRetentionMs(): number {
  return SOFT_DELETE_RETENTION_MS;
}

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
   * typed access instead. `visibility` is optional (not every entity has it)
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

  /** The unique-constraint columns a create must not conflict on (see {@link create}). */
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
   * Find the FIRST entity matching `filter` — a bounded (`LIMIT 1`) variant of
   * `find` for the "match by filter, take one" read paths (e.g. `GET /find`), so
   * they don't `SELECT` every matching org row just to return `[0]`.
   */
  async findFirst(filter: Partial<TFilter>, orgId?: string, parentOrgId?: string): Promise<TEntity | null> {
    const conditions = this.buildConditions(filter, orgId, parentOrgId);

    const results = await this.runRead(parentOrgId, () => withTenantTx(async (tx) => tx
      .select()
      .from(this.schema)
      .where(and(...conditions))
      .limit(1).then(r => drizzleRows<TEntity>(r))));

    return results[0] || null;
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

    // Total, deterministic order: (sort column, id). `id` is unique, so rows that
    // share a sort value have a stable relative order and a keyset cursor can
    // never skip or repeat them. An absent or UNKNOWN `sortBy` orders by `id`
    // alone — an unknown sort used to add no WHERE and no ORDER BY while still
    // emitting a cursor, so a cursor client looped on page 1 forever.
    const idColumn = this.cols.id;
    const sortColumn = (sortBy ? this.getSortColumn(sortBy) : null) ?? idColumn;
    const direction = sortOrder === 'desc' ? desc : asc;
    const orderBy = sortColumn === idColumn ? [direction(idColumn)] : [direction(sortColumn), direction(idColumn)];

    // Cursor and offset are mutually exclusive — a valid cursor takes precedence.
    // A malformed/tampered cursor — including well-formed JSON whose values
    // can't be cast to the id / sort column types — is ignored (reads from the
    // start) instead of reaching Postgres and failing the query.
    const rawCursor = cursor ? decodeCursor(cursor) : null;
    const decodedCursor = rawCursor
      && isCastableTo(idColumn, rawCursor.id)
      // (an id-only order never binds the sort value — see keysetAfter)
      && (sortColumn === idColumn || rawCursor.sortText === null || isCastableTo(sortColumn, rawCursor.sortText))
      ? rawCursor
      : null;
    if (cursor && !decodedCursor) {
      this._logger.warn('Ignoring malformed pagination cursor', { entity: this.constructor.name });
    }

    const conditions = this.buildConditions(filter, orgId, parentOrgId);
    if (decodedCursor) {
      conditions.push(keysetAfter(sortColumn, idColumn, sortOrder, decodedCursor.sortText, decodedCursor.id));
    }

    // Wrap the whole paginated read (SELECT + optional COUNT) in one
    // tenant tx. Both queries are visibility-scoped by the same RLS policy,
    // and pinning them to a single tx keeps the `app.org_id` GUC stable
    // between them. When widening to a parent org, the whole read runs under
    // sysadmin context (see runRead) so the access-control WHERE is the gate.
    return this.runRead(parentOrgId, () => withTenantTx(async (tx) => {
      // Projection: the sparse fieldset (always includes `id`) or every column,
      // plus the sort column's exact text for the next cursor.
      const baseSelect = (fields ? this.buildFieldSelect(fields) : undefined) ?? getTableColumns(this.schema);
      const selectSpec = { ...baseSelect, [CURSOR_SORT_KEY]: sql<string | null>`${sortColumn}::text` };

      // Fetch limit+1 to detect hasMore without COUNT(*)
      const effectiveOffset = decodedCursor ? 0 : offset;
      const rows = await tx.select(selectSpec as any).from(this.schema).where(and(...conditions))
        .orderBy(...orderBy)
        .limit(limit + 1)
        .offset(effectiveOffset).then(r => drizzleRows<Record<string, unknown>>(r));

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const data = page.map((row) => {
        const entity = { ...row };
        delete entity[CURSOR_SORT_KEY];
        return entity as TEntity;
      });

      const result: PaginatedResult<TEntity> = { data, limit, offset: effectiveOffset, hasMore };

      if (hasMore) {
        const last = page[page.length - 1];
        const sortText = last[CURSOR_SORT_KEY];
        result.nextCursor = encodeCursor(sortText == null ? null : String(sortText), String(last.id));
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
   * Falls back to full select if no fields are requested.
   *
   * `id` is always included — it is the entity identity AND the keyset cursor's
   * tie-breaker. The sort value for the cursor is projected separately (as text)
   * by `findPaginated`, so the fieldset need not carry the sort column.
   */
  private buildFieldSelect(fields: string[]): Record<string, unknown> | undefined {
    if (fields.length === 0) return undefined;

    const columns: Record<string, unknown> = {};
    // Always include id for entity identity
    columns.id = this.cols.id;

    for (const field of fields) {
      if (field === 'id') continue; // Already included
      const col = this.cols[field];
      if (col) columns[field] = col;
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
  // Generic over the payload shape so BOTH the create (`TInsert`) and update
  // (`Partial<TUpdate>`) call sites use it without the `as unknown as TInsert`
  // round-trip they previously needed — the org-stamp logic is identical for
  // either shape (it only touches the `orgId` key).
  protected enforceOrgId<T>(data: T, isCreate = false): T {
    const ctx = getTenantContext();
    const d = data as Record<string, unknown>;
    // Refuse a context-less, orgId-less INSERT on an org-scoped entity: the `orgId`
    // column defaults to SYSTEM_ORG_ID, so such a row would silently land in the
    // public cross-org catalog. A background job that forgot `runWithTenantContext`
    // (and didn't pass an explicit orgId) must fail loudly, not leak into `system`.
    // (Sysadmin/seed writes carry a context or an explicit orgId, so they pass.)
    if (isCreate && !ctx && d.orgId == null && this.cols.orgId != null) {
      throw new Error(`${this.constructor.name}.create requires an orgId (no tenant context and none supplied) — refusing to default to the system org`);
    }
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
      return { ...d, orgId: ctx.orgId } as T;
    }
    return data;
  }

  /**
   * Create a new entity
   */
  async create(data: TInsert, userId: string): Promise<TEntity> {
    const safeData = this.enforceOrgId(data, /* isCreate */ true);
    // Create never overwrites. The conflict key can match a LIVE row (another
    // author's, or one the caller couldn't edit through update) or a soft-deleted
    // TOMBSTONE; replacing either would bypass update's access checks or restore's
    // step-up. On any conflict nothing is written and the caller gets a 409.
    const [created] = await withTenantTx(async (tx) => tx
      .insert(this.schema)
      .values({
        ...safeData,
        createdBy: userId || 'system',
        updatedBy: userId || 'system',
      } as any)
      .onConflictDoNothing({ target: this.conflictTarget as any })
      .returning().then(r => drizzleRows<TEntity>(r)));

    if (!created) {
      throw new ConflictError('A record with the same identity already exists. If it was deleted, restore it instead.');
    }

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
    const safeData = this.enforceOrgId(data);

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
    const safeData = this.enforceOrgId(data);

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
   * The `visibility` predicate for a bulk soft-delete, mirroring
   * `requireVisibilityWriteAccess` rung for rung so bulk and single-row delete
   * can never disagree about what a caller may remove.
   *
   * Returns no condition at all for a system admin, or for an entity with no
   * `visibility` column (nothing to gate on).
   */
  private visibilityDeleteConditions(
    access: { isSystemAdmin: boolean; canPublish: boolean } | undefined,
    userId: string,
    accessCol?: AnyColumn,
    createdByCol?: AnyColumn,
  ): SQL[] {
    if (!accessCol) return [];
    if (!access || access.isSystemAdmin) return [];

    const rungs: SQL[] = [eq(accessCol, 'org')];
    // `private` is author-only. With no author column or no caller identity we
    // cannot prove authorship, so the rung is simply not offered (fail closed)
    // rather than matching every private row.
    if (createdByCol && userId) {
      rungs.push(and(eq(accessCol, 'private'), eq(createdByCol, userId)) as SQL);
    }
    if (access.canPublish) rungs.push(eq(accessCol, 'public'));

    return [or(...rungs) as SQL];
  }

  /**
   * Soft-delete multiple entities by IDs in a single batch operation.
   */
  async bulkDelete(
    ids: string[],
    orgId: string,
    userId: string,
    /**
     * The caller's authority on the three-rung `visibility` ladder. Omit (or
     * pass `isSystemAdmin: true`) for an unrestricted delete.
     *
     * This used to be a `restrictToPrivate` boolean that narrowed to
     * `visibility = 'private'`. That encoded the OLD two-state model: since
     * `resolveVisibility` defaults pipelines and plugins to `org`, and
     * single-row delete allows an `org` row with plain `:write`, bulk delete
     * 403'd the normal case — an org admin could delete a pipeline one at a
     * time but not in bulk. The rungs enforced here mirror
     * `requireVisibilityWriteAccess` exactly:
     *   - `private` → author only (`createdBy === userId`)
     *   - `org`     → any member of the org (plain `:write`)
     *   - `public`  → requires the entity's publish permission
     */
    access?: { isSystemAdmin: boolean; canPublish: boolean },
  ): Promise<TEntity[]> {
    if (ids.length === 0) return [];

    const now = new Date();
    const user = userId || 'system';
    // Owner-scope the bulk soft-delete: buildConditions also matches system/other
    // -org PUBLIC rows, so without the strict orgId pin a tenant could delete
    // shared records by id. (See writeConditions.)
    const accessCol = this.cols.visibility;
    const createdByCol = this.cols.createdBy;
    const conditions = [
      inArray(this.cols.id, ids),
      ...this.buildConditions({} as Partial<TFilter>, orgId),
      // Tenant column (getOrgColumn, asserted non-null) — consistent with
      // writeConditions; no silent fail-open when the property is absent.
      ...(orgId ? [eq(this.getOrgColumn(), orgId)] : []),
      ...this.visibilityDeleteConditions(access, userId, accessCol, createdByCol),
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
      ...this.tombstoneVisibilityConditions(),
    ];
    if (id !== undefined) conditions.unshift(this.exactIdCondition(id));
    if (orgId) conditions.push(eq(this.getOrgColumn(), orgId));
    return conditions;
  }

  /**
   * The `private` rung, for TOMBSTONE reads and restore.
   *
   * Deleting a row does not declassify it. These conditions carried only
   * `isActive=false + deletedAt IS NOT NULL + org_id = O`, so the "recently
   * deleted" list handed every member of an org the tombstones of everyone
   * else's PRIVATE pipelines, plugins and templates — rows the very same member
   * could not read one second before they were deleted. `restore` shared the
   * clause, so they could also bring one back.
   *
   * Mirrors the live read ladder (`visibility <> 'private' OR created_by = V`)
   * rather than the delete ladder: this gates who may SEE a tombstone, and a
   * tombstone should be visible to exactly whoever could see the row. A
   * super-admin administers the whole catalog, so the rung lifts for them.
   *
   * Fails CLOSED: with no author column or no viewer (background jobs, the
   * retention sweep) the private rung is not offered at all rather than
   * matching every private row. `purgeExpired` deliberately does not use this —
   * it runs org-wide under a sysadmin scope and must reach every tombstone.
   */
  private tombstoneVisibilityConditions(): SQL[] {
    const accessCol = this.cols.visibility;
    if (!accessCol) return [];
    const ctx = getTenantContext();
    if (ctx?.isSuperAdmin) return [];

    const createdByCol = this.cols.createdBy;
    const viewer = ctx?.userId;
    const rungs: SQL[] = [sql`${accessCol} <> 'private'`];
    if (createdByCol && viewer) rungs.push(eq(createdByCol, viewer));
    return [or(...rungs) as SQL];
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

  /**
   * On-demand hard-delete of a SINGLE tombstone by id — the manual counterpart
   * to the retention sweep's `purgeExpired`. Permanently removes the row ONLY
   * when it is a genuine tombstone (`isActive=false` + `deletedAt IS NOT NULL`),
   * optionally pinned to `orgId` (an orgId-less sysadmin context spans orgs,
   * matching restore/delete). Runs the same `onBeforePurge` dependent teardown
   * inside the tx and the same `onAfterPurge` side-effects as the sweep.
   *
   * Ignores `purgeAfter`: a manual purge finalizes an already-soft-deleted item
   * immediately rather than waiting for the retention deadline. Returns the
   * purged id, or null when there is no such tombstone (already active, purged,
   * out of scope, or unknown) so the route can 404.
   */
  async purgeById(id: string, orgId?: string): Promise<string | null> {
    if (!this.cols.deletedAt) return null;
    const conditions = this.tombstoneConditions(orgId, id);

    const purgedId = await withTenantTx(async (tx) => {
      const [doomed] = await tx
        // `as any`: cols.id is the base `AnyColumn`, which drizzle's typed
        // select-field map doesn't accept directly (same friction elsewhere).
        .select({ id: this.cols.id as any })
        .from(this.schema)
        .where(and(...conditions))
        .limit(1)
        .then(r => (r as Array<{ id: unknown }>).map(d => String(d.id)));

      if (!doomed) return null;

      // Dependent teardown in the same tx (FK-blocking children can't strand
      // the parent) — identical to the sweep's per-batch path.
      await this.onBeforePurge([doomed], tx);
      await tx.delete(this.schema).where(inArray(this.cols.id, [doomed]));
      return doomed;
    });

    if (purgedId) {
      try {
        await this.onAfterPurge([purgedId]);
      } catch (err) {
        this._logger.warn('Lifecycle hook failed', { error: String(err) });
      }
    }

    return purgedId;
  }
}
