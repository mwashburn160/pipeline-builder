// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data access for the plugin ecosystem's governance tables (publishers,
 * listings, listing versions, the publish-request queue, auto-approval rules,
 * reserved names, settings) — docs/plans/plugin-ecosystem.md §3.
 *
 * Every function runs ELEVATED (superadmin tenant context): the ecosystem
 * tables are instance-wide (no `org_id`, app-role-only RLS), and a moderator's
 * review reads the requesting org's `plugins` row, which FORCE RLS would hide
 * from the system org. Authorization is therefore the CALLER's job — each
 * function that touches org data takes an explicit org filter, and the route
 * layer decides who may call what. Nothing here is reachable from a request
 * without passing through a permission gate first.
 *
 * Deliberately plain queries (no joins, no raw SQL): the service composes rows
 * in memory, and the test suite exercises the whole layer against an in-memory
 * fake. Filters, ordering, limits and counts are pushed into SQL.
 *
 * TRANSACTIONS: every store call runs in its own elevated transaction — unless
 * it runs inside {@link atomically}, in which case it JOINS that transaction
 * (an AsyncLocalStorage-carried handle). A multi-write decision wraps its writes
 * in one `atomically` block, so every store call inside commits or rolls back
 * together, with no tx threaded through the call graph.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  runWithTenantContext,
  schema,
  withTenantTx,
  type EcosystemAutoApprovalRule,
  type EcosystemAutoApprovalRuleInsert,
  type EcosystemReservedName,
  type PluginListing,
  type PluginListingInsert,
  type PluginListingVersion,
  type PluginListingVersionInsert,
  type PluginPublishRequest,
  type PluginPublishRequestInsert,
  type Publisher,
  type PublisherInsert,
  type PublishRequestKind,
  type PublishRequestStatus,
} from '@pipeline-builder/pipeline-data';
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';

type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];
export type PluginRow = typeof schema.plugin.$inferSelect;

const ambientTx = new AsyncLocalStorage<Tx>();

/**
 * Run `fn` in one elevated transaction (see the module note) — the ambient
 * {@link atomically} transaction when there is one.
 */
export function elevated<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = ambientTx.getStore();
  if (tx) return fn(tx);
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
}

/**
 * Run `fn` so that EVERY store call inside it shares one elevated transaction:
 * all of its writes commit together or none do. Nested calls join the outer
 * block. Keep network I/O (registry, notifications) OUT of it — do that before
 * (idempotent work) or after (announcements) the block.
 */
export function atomically<T>(fn: () => Promise<T>): Promise<T> {
  if (ambientTx.getStore()) return fn();
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => ambientTx.run(tx, fn)));
}

/** Whether the caller is inside an {@link atomically} block. */
export function inTransaction(): boolean {
  return ambientTx.getStore() !== undefined;
}

const first = <T>(rows: T[]): T | null => rows[0] ?? null;
const P = () => schema.publisher;
const L = () => schema.pluginListing;
const V = () => schema.pluginListingVersion;
const R = () => schema.pluginPublishRequest;

// -----------------------------------------------------------------------------
// Publishers
// -----------------------------------------------------------------------------

export const publishers = {
  byId: (id: string): Promise<Publisher | null> =>
    elevated(async (tx) => first(await tx.select().from(P()).where(eq(P().id, id)))),
  byOrg: (orgId: string): Promise<Publisher | null> =>
    elevated(async (tx) => first(await tx.select().from(P()).where(eq(P().ownerOrgId, orgId.toLowerCase())))),
  byHandle: (handle: string): Promise<Publisher | null> =>
    elevated(async (tx) => first(await tx.select().from(P()).where(eq(P().handle, handle)))),
  byIds: (ids: string[]): Promise<Publisher[]> =>
    ids.length === 0 ? Promise.resolve([]) : elevated(async (tx) => tx.select().from(P()).where(inArray(P().id, ids))),
  list: (filter: { tier?: string; suspended?: boolean } = {}): Promise<Publisher[]> =>
    elevated(async (tx) => {
      const where: SQL[] = [];
      if (filter.tier) where.push(eq(P().tier, filter.tier as Publisher['tier']));
      const rows = await tx.select().from(P()).where(and(...where)).orderBy(desc(P().createdAt));
      if (filter.suspended === undefined) return rows;
      return rows.filter((r) => (r.suspendedAt !== null) === filter.suspended);
    }),
  insert: (values: PublisherInsert): Promise<Publisher> =>
    elevated(async (tx) => (await tx.insert(P()).values(values).returning())[0] as Publisher),
  update: (id: string, patch: Partial<PublisherInsert>): Promise<Publisher | null> =>
    elevated(async (tx) => first(await tx.update(P()).set({ ...patch, updatedAt: new Date() }).where(eq(P().id, id)).returning())),
};

// -----------------------------------------------------------------------------
// Listings + versions
// -----------------------------------------------------------------------------

/** A listing counts toward the `listings` quota while it is public (§3.7). */
export const ACTIVE_LISTING_STATES = ['listed', 'unmaintained'] as const;

export const listings = {
  byId: (id: string): Promise<PluginListing | null> =>
    elevated(async (tx) => first(await tx.select().from(L()).where(eq(L().id, id)))),
  byIds: (ids: string[]): Promise<PluginListing[]> =>
    ids.length === 0 ? Promise.resolve([]) : elevated(async (tx) => tx.select().from(L()).where(inArray(L().id, ids))),
  byName: (publisherId: string, name: string): Promise<PluginListing | null> =>
    elevated(async (tx) => first(await tx.select().from(L()).where(and(eq(L().publisherId, publisherId), eq(L().name, name))))),
  list: (filter: { publisherId?: string; state?: string } = {}): Promise<PluginListing[]> =>
    elevated(async (tx) => {
      const where: SQL[] = [];
      if (filter.publisherId) where.push(eq(L().publisherId, filter.publisherId));
      if (filter.state) where.push(eq(L().state, filter.state as PluginListing['state']));
      return tx.select().from(L()).where(and(...where)).orderBy(desc(L().updatedAt));
    }),
  /** Listings the publisher has live in the directory (the `listings` quota count). */
  countActive: (publisherId: string): Promise<number> =>
    elevated(async (tx) => Number((await tx.select({ n: count() }).from(L())
      .where(and(eq(L().publisherId, publisherId), inArray(L().state, [...ACTIVE_LISTING_STATES]))))[0]?.n ?? 0)),
  /** Every listing on the instance, in any state (the bootstrap check). */
  countAll: (): Promise<number> =>
    elevated(async (tx) => Number((await tx.select({ n: count() }).from(L()))[0]?.n ?? 0)),
  insert: (values: PluginListingInsert): Promise<PluginListing> =>
    elevated(async (tx) => (await tx.insert(L()).values(values).returning())[0] as PluginListing),
  update: (id: string, patch: Partial<PluginListingInsert>): Promise<PluginListing | null> =>
    elevated(async (tx) => first(await tx.update(L()).set({ ...patch, updatedAt: new Date() }).where(eq(L().id, id)).returning())),
};

export const versions = {
  /** How many versions a listing has (any state) — a listing with none is an empty shell a publish may reuse. */
  countForListing: (listingId: string): Promise<number> =>
    elevated(async (tx) => Number((await tx.select({ n: count() }).from(V()).where(eq(V().listingId, listingId)))[0]?.n ?? 0)),
  forListings: (listingIds: string[]): Promise<PluginListingVersion[]> =>
    listingIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
      tx.select().from(V()).where(inArray(V().listingId, listingIds)).orderBy(desc(V().publishedAt))),
  get: (listingId: string, version: string): Promise<PluginListingVersion | null> =>
    elevated(async (tx) => first(await tx.select().from(V()).where(and(eq(V().listingId, listingId), eq(V().version, version))))),
  /** Listing versions published from any of these org plugin rows. */
  bySourcePlugins: (pluginIds: string[]): Promise<PluginListingVersion[]> =>
    pluginIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
      tx.select().from(V()).where(inArray(V().sourcePluginId, pluginIds))),
  insert: (values: PluginListingVersionInsert): Promise<PluginListingVersion> =>
    elevated(async (tx) => (await tx.insert(V()).values(values).returning())[0] as PluginListingVersion),
  update: (id: string, patch: Partial<PluginListingVersionInsert>): Promise<PluginListingVersion | null> =>
    elevated(async (tx) => first(await tx.update(V()).set(patch).where(eq(V().id, id)).returning())),
};

// -----------------------------------------------------------------------------
// Publish requests
// -----------------------------------------------------------------------------

export const OPEN_STATUSES: PublishRequestStatus[] = ['pending', 'pending_second_approval'];

/**
 * `column #>> '{path}' = value` for a jsonb column, as SQL. The predicate also
 * carries its parts (`jsonPathEq`) so the in-memory test double can evaluate
 * it; Postgres only ever sees the SQL.
 */
export function jsonPathEq(column: AnyColumn, path: string[], value: string): SQL {
  const predicate = sql`${column} #>> ${`{${path.join(',')}}`} = ${value}`;
  return Object.assign(predicate, { jsonPathEq: { column, path, value } });
}

/** A keyset position in a `(created_at, id)`-ordered request list. */
export interface RequestCursor { createdAt: Date; id: string }

/** Encode a cursor for an API response (opaque to the client). */
export function encodeRequestCursor(r: Pick<PluginPublishRequest, 'createdAt' | 'id'>): string {
  return Buffer.from(`${new Date(r.createdAt).toISOString()}|${r.id}`).toString('base64url');
}

/** Decode a client-supplied cursor; null (→ first page) when absent, 400 upstream when malformed. */
export function decodeRequestCursor(raw: unknown): RequestCursor | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 200) return 'invalid';
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(createdAt.getTime())) return 'invalid';
  return { createdAt, id };
}

export interface RequestFilter {
  publisherId?: string;
  statuses?: PublishRequestStatus[];
  kinds?: PublishRequestKind[];
  lane?: 'standard' | 'security';
  pluginId?: string;
  listingId?: string;
  /** Auto-approved rows only (a rule, or the bootstrap exception). */
  autoOnly?: boolean;
  /** A transfer offered TO this publisher (`payload.transfer.targetPublisherId`). */
  transferTargetPublisherId?: string;
  /** An anonymous submission's request (`payload.submissionId`). */
  submissionId?: string;
  limit?: number;
  /** `desc` (newest first, the default) or `asc` (oldest first — the open queue's SLA order). */
  order?: 'asc' | 'desc';
  /** Continue after this row (keyset pagination in `order`). */
  cursor?: RequestCursor | null;
}

function requestWhere(filter: RequestFilter, withCursor: boolean): SQL | undefined {
  const where: SQL[] = [];
  if (filter.publisherId) where.push(eq(R().publisherId, filter.publisherId));
  if (filter.statuses?.length) where.push(inArray(R().status, filter.statuses));
  if (filter.kinds?.length) where.push(inArray(R().kind, filter.kinds));
  if (filter.lane) where.push(eq(R().lane, filter.lane));
  if (filter.pluginId) where.push(eq(R().pluginId, filter.pluginId));
  if (filter.listingId) where.push(eq(R().listingId, filter.listingId));
  if (filter.autoOnly) where.push(or(isNotNull(R().autoRuleId), jsonPathEq(R().payload, ['bootstrap'], 'true'))!);
  if (filter.transferTargetPublisherId) where.push(jsonPathEq(R().payload, ['transfer', 'targetPublisherId'], filter.transferTargetPublisherId));
  if (filter.submissionId) where.push(jsonPathEq(R().payload, ['submissionId'], filter.submissionId));
  const c = withCursor ? filter.cursor : null;
  if (c) {
    const past = filter.order === 'asc' ? gt : lt;
    where.push(or(past(R().createdAt, c.createdAt), and(eq(R().createdAt, c.createdAt), past(R().id, c.id)))!);
  }
  return and(...where);
}

export const requests = {
  byId: (id: string): Promise<PluginPublishRequest | null> =>
    elevated(async (tx) => first(await tx.select().from(R()).where(eq(R().id, id)))),
  /** One page, filtered, ordered and limited in SQL (keyset on `(created_at, id)`). */
  list: (filter: RequestFilter = {}): Promise<PluginPublishRequest[]> =>
    elevated(async (tx) => {
      const dir = filter.order === 'asc' ? asc : desc;
      return tx.select().from(R()).where(requestWhere(filter, true))
        .orderBy(dir(R().createdAt), dir(R().id)).limit(filter.limit ?? 200);
    }),
  /** How many rows match `filter` (cursor and limit ignored) — the queue's total. */
  count: (filter: RequestFilter = {}): Promise<number> =>
    elevated(async (tx) => Number((await tx.select({ n: count() }).from(R()).where(requestWhere(filter, false)))[0]?.n ?? 0)),
  insert: (values: PluginPublishRequestInsert): Promise<PluginPublishRequest> =>
    elevated(async (tx) => (await tx.insert(R()).values(values).returning())[0] as PluginPublishRequest),
  /**
   * Move a request on, but only from `fromStatus` — the optimistic lock that
   * stops two managers (or a manager and the submitter's withdraw) from both
   * deciding one request. Null when it was no longer in that status.
   */
  transition: (id: string, fromStatus: PublishRequestStatus, patch: Partial<PluginPublishRequestInsert>): Promise<PluginPublishRequest | null> =>
    elevated(async (tx) => first(await tx.update(R()).set(patch).where(and(eq(R().id, id), eq(R().status, fromStatus))).returning())),
  /** Rows auto-approved by a rule since `since` (the §3.0.3 rate caps). */
  autoApprovedSince: (ruleId: string, since: Date): Promise<PluginPublishRequest[]> =>
    elevated(async (tx) => tx.select().from(R()).where(and(eq(R().autoRuleId, ruleId), gte(R().decidedAt, since)))),
};

// -----------------------------------------------------------------------------
// Auto-approval rules, reserved names, settings
// -----------------------------------------------------------------------------

const AR = () => schema.ecosystemAutoApprovalRule;

export const rules = {
  list: (): Promise<EcosystemAutoApprovalRule[]> =>
    elevated(async (tx) => tx.select().from(AR()).orderBy(desc(AR().createdAt))),
  byId: (id: string): Promise<EcosystemAutoApprovalRule | null> =>
    elevated(async (tx) => first(await tx.select().from(AR()).where(eq(AR().id, id)))),
  insert: (values: EcosystemAutoApprovalRuleInsert): Promise<EcosystemAutoApprovalRule> =>
    elevated(async (tx) => (await tx.insert(AR()).values(values).returning())[0] as EcosystemAutoApprovalRule),
  update: (id: string, patch: Partial<EcosystemAutoApprovalRuleInsert>): Promise<EcosystemAutoApprovalRule | null> =>
    elevated(async (tx) => first(await tx.update(AR()).set({ ...patch, updatedAt: new Date() }).where(eq(AR().id, id)).returning())),
  remove: (id: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.delete(AR()).where(eq(AR().id, id)).returning()).length > 0),
};

const RN = () => schema.ecosystemReservedName;

export const reservedNames = {
  list: (): Promise<EcosystemReservedName[]> =>
    elevated(async (tx) => tx.select().from(RN()).orderBy(desc(RN().createdAt))),
  get: (name: string): Promise<EcosystemReservedName | null> =>
    elevated(async (tx) => first(await tx.select().from(RN()).where(eq(RN().name, name)))),
  put: (name: string, reason: string | null, publisherId: string | null): Promise<EcosystemReservedName> =>
    elevated(async (tx) => {
      const existing = first(await tx.select().from(RN()).where(eq(RN().name, name)));
      if (existing) {
        return (await tx.update(RN()).set({ reason, publisherId }).where(eq(RN().name, name)).returning())[0] as EcosystemReservedName;
      }
      return (await tx.insert(RN()).values({ name, reason, publisherId }).returning())[0] as EcosystemReservedName;
    }),
  remove: (name: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.delete(RN()).where(eq(RN().name, name)).returning()).length > 0),
};

const S = () => schema.ecosystemSetting;

export const settings = {
  get: <T>(key: string): Promise<T | null> =>
    elevated(async (tx) => (first(await tx.select().from(S()).where(eq(S().key, key)))?.value as T | undefined) ?? null),
  put: (key: string, value: unknown, by: string): Promise<void> =>
    elevated(async (tx) => {
      const existing = first(await tx.select().from(S()).where(eq(S().key, key)));
      if (existing) await tx.update(S()).set({ value, updatedBy: by, updatedAt: new Date() }).where(eq(S().key, key));
      else await tx.insert(S()).values({ key, value, updatedBy: by });
    }),
  remove: (key: string): Promise<void> =>
    elevated(async (tx) => { await tx.delete(S()).where(eq(S().key, key)); }),
  /**
   * Read a setting with a ROW LOCK (`SELECT … FOR UPDATE`) — inside an
   * {@link atomically} block, the read-modify-write that follows can't be lost
   * to a concurrent writer of the same key.
   */
  getForUpdate: <T>(key: string): Promise<T | null> =>
    elevated(async (tx) => (first(await tx.select().from(S()).where(eq(S().key, key)).for('update'))?.value as T | undefined) ?? null),
  /** Every setting whose key starts with `prefix` (job bookkeeping). */
  withPrefix: (prefix: string): Promise<Array<{ key: string; value: unknown }>> =>
    elevated(async (tx) => (await tx.select().from(S()).where(like(S().key, `${prefix}%`))).map((r) => ({ key: r.key, value: r.value }))),
};

// -----------------------------------------------------------------------------
// Org plugin rows (read for requests + review; frozen on decisions)
// -----------------------------------------------------------------------------

const PL = () => schema.plugin;

export const plugins = {
  /** A LIVE plugin row, optionally pinned to its owning org. */
  byId: (id: string, orgId?: string): Promise<PluginRow | null> =>
    elevated(async (tx) => first(await tx.select().from(PL()).where(and(
      eq(PL().id, id),
      isNull(PL().deletedAt),
      ...(orgId ? [eq(PL().orgId, orgId.toLowerCase())] : []),
    )))),
  /**
   * The distinct names of an org's LIVE `public` plugins — the only repositories
   * of its namespace a team of it may pull (image-registry, E22).
   */
  publicNames: (orgId: string): Promise<string[]> =>
    elevated(async (tx) => [...new Set((await tx.select({ name: PL().name }).from(PL()).where(and(
      eq(PL().orgId, orgId.toLowerCase()),
      eq(PL().visibility, 'public'),
      isNull(PL().deletedAt),
    ))).map((r) => r.name))].sort()),
  /** Clear a request freeze once no open request references the version (rejected / withdrawn). */
  unfreeze: (id: string): Promise<void> =>
    elevated(async (tx) => { await tx.update(PL()).set({ frozenAt: null }).where(eq(PL().id, id)); }),
};
