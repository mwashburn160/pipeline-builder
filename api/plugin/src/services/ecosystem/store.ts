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
 * Deliberately plain queries (no joins, no raw SQL): the ecosystem tables are
 * small, the service composes rows in memory, and the test suite exercises the
 * whole layer against an in-memory fake.
 */

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
import { and, desc, eq, gte, inArray, isNull, like, type SQL } from 'drizzle-orm';

type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];
export type PluginRow = typeof schema.plugin.$inferSelect;

/** Run `fn` in one elevated transaction (see the module note). */
export function elevated<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
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
    elevated(async (tx) => (await tx.select({ id: L().id }).from(L())
      .where(and(eq(L().publisherId, publisherId), inArray(L().state, [...ACTIVE_LISTING_STATES])))).length),
  /** Every listing on the instance, in any state (the bootstrap check). */
  countAll: (): Promise<number> =>
    elevated(async (tx) => (await tx.select({ id: L().id }).from(L())).length),
  insert: (values: PluginListingInsert): Promise<PluginListing> =>
    elevated(async (tx) => (await tx.insert(L()).values(values).returning())[0] as PluginListing),
  update: (id: string, patch: Partial<PluginListingInsert>): Promise<PluginListing | null> =>
    elevated(async (tx) => first(await tx.update(L()).set({ ...patch, updatedAt: new Date() }).where(eq(L().id, id)).returning())),
};

export const versions = {
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

export interface RequestFilter {
  publisherId?: string;
  statuses?: PublishRequestStatus[];
  kinds?: PublishRequestKind[];
  lane?: 'standard' | 'security';
  pluginId?: string;
  listingId?: string;
  autoOnly?: boolean;
  limit?: number;
}

export const requests = {
  byId: (id: string): Promise<PluginPublishRequest | null> =>
    elevated(async (tx) => first(await tx.select().from(R()).where(eq(R().id, id)))),
  list: (filter: RequestFilter = {}): Promise<PluginPublishRequest[]> =>
    elevated(async (tx) => {
      const where: SQL[] = [];
      if (filter.publisherId) where.push(eq(R().publisherId, filter.publisherId));
      if (filter.statuses?.length) where.push(inArray(R().status, filter.statuses));
      if (filter.kinds?.length) where.push(inArray(R().kind, filter.kinds));
      if (filter.lane) where.push(eq(R().lane, filter.lane));
      if (filter.pluginId) where.push(eq(R().pluginId, filter.pluginId));
      if (filter.listingId) where.push(eq(R().listingId, filter.listingId));
      const rows = await tx.select().from(R()).where(and(...where)).orderBy(desc(R().createdAt)).limit(filter.limit ?? 200);
      return filter.autoOnly ? rows.filter((r) => r.autoRuleId !== null || r.payload?.bootstrap === true) : rows;
    }),
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
  /** Clear a request freeze once no open request references the version (rejected / withdrawn). */
  unfreeze: (id: string): Promise<void> =>
    elevated(async (tx) => { await tx.update(PL()).set({ frozenAt: null }).where(eq(PL().id, id)); }),
};
