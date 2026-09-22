// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { and, eq, ne, or, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Escape SQL LIKE wildcard characters to prevent wildcard injection.
 * Replaces `%` → `\\%`, `_` → `\\_`, and `\\` → `\\\\`.
 */
export function escapeLikeWildcards(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Build a condition that checks if a JSONB text array column contains a keyword (case-insensitive).
 * Used for keywords/tags filtering on pipelines, plugins, and compliance rules.
 */
export function buildJsonbKeywordCondition(column: AnyColumn, keyword: string): SQL {
  const escaped = escapeLikeWildcards(keyword.toLowerCase());
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}) AS el WHERE lower(el) LIKE ${'%' + escaped + '%'})`;
}

/**
 * Parse boolean filter value from string or boolean
 */
export function parseBooleanFilter(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return Boolean(value);
}

/**
 * Normalize string filter value to lowercase
 */
export function normalizeStringFilter(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : String(value).toLowerCase();
}

/**
 * Build an ID predicate with UUID prefix matching.
 *
 * - Full UUID → exact match
 * - Partial UUID → prefix match via `LIKE` (a list-search affordance)
 * - Absent → `null` (no predicate)
 *
 * Standalone so entities that DON'T use {@link AccessControlQueryBuilder}'s
 * access control (e.g. pipeline templates, which carry their own three-rung
 * visibility ladder) still share one id-matching implementation.
 */
export function buildIdCondition(idColumn: AnyColumn, id: unknown): SQL | null {
  if (id === undefined || id === null) return null;

  // `BaseAccessFilter.id` is declared `string | string[]`, so honour the array
  // form: match ANY of the ids, each with the same exact-vs-prefix semantics as
  // a single value. `String(['a','b'])` would otherwise produce `LIKE 'a,b%'`
  // and silently return zero rows — a trap for the first caller to pass one.
  if (Array.isArray(id)) {
    const parts = id
      .map((one) => buildIdCondition(idColumn, one))
      .filter((c): c is SQL => c !== null);
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : (or(...parts) as SQL);
  }

  const idString = String(id).toLowerCase();
  if (FULL_UUID.test(idString)) {
    return eq(idColumn, idString);
  }
  // Escape SQL LIKE wildcards to prevent wildcard injection
  const escaped = escapeLikeWildcards(idString);
  return sql`${idColumn}::text LIKE ${escaped + '%'} ESCAPE '\\'`;
}

/**
 * Build the `isDefault` / `isActive` predicates shared by every catalog entity.
 * `isActive` defaults to true so soft-deleted rows stay out of normal reads.
 * Standalone for the same reason as {@link buildIdCondition}.
 */
export function buildBooleanConditions(
  columns: { isDefault: AnyColumn; isActive: AnyColumn },
  filter: { isDefault?: unknown; isActive?: unknown },
): SQL[] {
  const conditions: SQL[] = [];

  if (filter.isDefault !== undefined) {
    conditions.push(eq(columns.isDefault, parseBooleanFilter(filter.isDefault)));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(columns.isActive, parseBooleanFilter(filter.isActive)));
  } else {
    // Default to active records only to exclude soft-deleted entities
    conditions.push(eq(columns.isActive, true));
  }

  return conditions;
}

/**
 * Schema table interface for access control queries. Every catalog entity
 * carries the same five columns, which is what lets ONE predicate serve
 * pipelines, plugins and templates alike.
 */
export interface AccessControlSchema {
  id: AnyColumn;
  orgId: AnyColumn;
  /** Three-rung sharing ladder — see api-core's `Visibility`. */
  visibility: AnyColumn;
  /** Author. Owns the `private` rung. */
  createdBy: AnyColumn;
  isDefault: AnyColumn;
  isActive: AnyColumn;
}

/**
 * Base filter interface with common access control fields.
 *
 * `viewerUserId` / `viewerIsSuperAdmin` are SERVER-SET (stamped from the request's
 * tenant context by `withViewerContext`), never client-supplied — see
 * `viewer-context.ts` for why the tenant context is the channel.
 */
export interface BaseAccessFilter {
  id?: string | string[];
  visibility?: string;
  isDefault?: boolean | string;
  isActive?: boolean | string;
  viewerUserId?: string;
  viewerIsSuperAdmin?: boolean;
}

/** Fail-closed predicate: matches no rows. */
const NO_ROWS: SQL = sql`false`;

/** Per-entity tuning of {@link AccessControlQueryBuilder}. */
export interface AccessControlOptions {
  /**
   * Whether the SYSTEM org's `public` rung reaches callers in other orgs (and
   * anonymous callers). Default true: the system org's sample pipelines,
   * templates and dashboards are visible from every org. Plugins set it false:
   * since the plugin ecosystem the Official catalog reaches
   * other orgs only as LISTINGS resolved through installs, never through
   * `visibility = 'public'` on a `plugins` row.
   */
  systemCatalog?: boolean;
}

/**
 * Generic access control query builder for multi-tenant entities.
 *
 * Consolidates duplicate access control logic shared across pipeline and plugin queries.
 * Handles:
 * - Multi-tenant access control (public/private/org-and-public)
 * - UUID prefix matching for ID filters
 * - Boolean field normalization
 *
 * @typeParam TSchema - Schema table type with access control fields
 * @typeParam TFilter - Filter type extending BaseAccessFilter
 */
export class AccessControlQueryBuilder<
  TSchema extends AccessControlSchema,
  TFilter extends BaseAccessFilter,
> {
  constructor(
    private schema: TSchema,
    private options: AccessControlOptions = {},
  ) {}

  /**
   * Build the caller's visible slice of a catalog, from the three-rung
   * `visibility` ladder shared by every catalog entity.
   *
   * Effective read set for a caller in org `O` as user `V` whose parent org is `P`:
   *
   *   (org_id = O AND (visibility <> 'private' OR created_by = V))
   *   OR (visibility = 'public' AND (org_id = 'system' OR org_id = P))
   *
   * i.e. your own org's shared rungs plus your own drafts, widened by the system
   * org's public catalog (the standing "system-org content is visible from every
   * org" rule) and — for a team — its parent's public rows. The `public`-only
   * restriction applies solely to those OTHER orgs' rows; within your own org you
   * always see everything you are entitled to, or a freshly-created private row
   * would vanish from its own author's listing.
   *
   * An entity can drop the system-org branch with `systemCatalog: false`
   * ({@link AccessControlOptions}): plugins do, so a system-org plugin reaches
   * other orgs only as an Official listing.
   *
   * An explicit `visibility` filter NARROWS within that set, never widens it —
   * so `?visibility=public` still surfaces the system-org catalog.
   *
   * Fails CLOSED on both axes: no `orgId` (anonymous) ⇒ system-org public only;
   * no `viewerUserId` ⇒ the private rung matches nothing rather than everything.
   * `viewerIsSuperAdmin` lifts the private rung only — a platform operator
   * administers the whole catalog.
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional)
   * @param parentOrgId - Parent org ID when the caller is a team (optional)
   * @returns Array of SQL conditions for access control
   */
  protected buildAccessControl(filter: Partial<TFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    const conditions: SQL[] = [];
    const requested = filter.visibility;

    const systemCatalog = this.options.systemCatalog !== false;

    if (!orgId) {
      // No org context — only the system org's public catalog (nothing at all
      // for an entity without one).
      if (!systemCatalog) return [NO_ROWS];
      conditions.push(eq(this.schema.orgId, SYSTEM_ORG_ID));
      conditions.push(eq(this.schema.visibility, 'public'));
      // An anonymous caller asking for a narrower rung gets nothing, rather than
      // having the narrowing silently ignored.
      if (requested !== undefined && requested !== 'public') conditions.push(NO_ROWS);
      return conditions;
    }

    const normalizedOrgId = orgId.toLowerCase();

    // Own-org rows: everything EXCEPT other people's private drafts.
    const ownDraftsOnly = filter.viewerUserId ? eq(this.schema.createdBy, filter.viewerUserId) : NO_ROWS;
    const ownOrg = filter.viewerIsSuperAdmin
      ? eq(this.schema.orgId, normalizedOrgId)
      : and(eq(this.schema.orgId, normalizedOrgId), or(ne(this.schema.visibility, 'private'), ownDraftsOnly)!)!;

    // Rows from OTHER orgs are only ever visible at the `public` rung.
    const otherOrgScopes: SQL[] = [];
    if (systemCatalog) otherOrgScopes.push(eq(this.schema.orgId, SYSTEM_ORG_ID));
    if (parentOrgId) otherOrgScopes.push(eq(this.schema.orgId, parentOrgId.toLowerCase()));
    conditions.push(otherOrgScopes.length > 0
      ? or(ownOrg, and(eq(this.schema.visibility, 'public'), or(...otherOrgScopes)!)!)!
      : ownOrg);

    if (requested !== undefined) conditions.push(eq(this.schema.visibility, requested));

    return conditions;
  }

  /**
   * Build ID filter with UUID prefix matching support
   *
   * - Full UUID: Exact match
   * - Partial UUID: Prefix match using SQL LIKE
   *
   * @param id - ID filter value (full or partial UUID)
   * @returns SQL condition or null if no ID filter
   */
  protected buildIdFilter(id: unknown): SQL | null {
    return buildIdCondition(this.schema.id, id);
  }

  /**
   * Build boolean field conditions (isDefault, isActive)
   *
   * @param filter - Filter criteria
   * @returns Array of SQL conditions for boolean fields
   */
  protected buildBooleanFilters(filter: Partial<TFilter>): SQL[] {
    return buildBooleanConditions(this.schema, filter);
  }

  /**
   * Build all common conditions (access control + ID + booleans)
   *
   * This combines all the generic filters that apply to any access-controlled entity.
   * Subclasses should call this and add entity-specific conditions.
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — falls back to system-public-only)
   * @returns Array of SQL conditions
   */
  public buildCommonConditions(filter: Partial<TFilter>, orgId?: string, parentOrgId?: string): SQL[] {
    const conditions: SQL[] = [];

    // Access control (multi-tenant) — handles visibility internally
    conditions.push(...this.buildAccessControl(filter, orgId, parentOrgId));

    // ID filter with prefix matching
    const idCondition = this.buildIdFilter(filter.id);
    if (idCondition) conditions.push(idCondition);

    // Boolean filters
    conditions.push(...this.buildBooleanFilters(filter));

    return conditions;
  }
}
