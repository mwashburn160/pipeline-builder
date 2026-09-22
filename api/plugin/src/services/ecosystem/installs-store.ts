// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data access for installs and the org consumption policy
 * (docs/plans/plugin-ecosystem.md §3.2), and the {@link ListingDataSource} the
 * shared resolver (pipeline-data `plugin-resolution.ts`) reads through.
 *
 * Runs ELEVATED like the rest of the ecosystem store (see store.ts): the
 * ecosystem tables are instance-wide, and a team's resolution reads its ROOT
 * org's install and policy rows, which RLS would hide from the team. Every
 * function that touches org rows therefore takes an explicit org filter, and
 * the route layer decides who may call it.
 */

import {
  OFFICIAL_PUBLISHER_HANDLE,
  schema,
  type ListingDataSource,
  type InstallChangeRequest,
  type PluginInstall,
  type PluginInstallInsert,
  type PluginInstallPolicy,
  type PluginInstallPolicyInsert,
  type PluginAdvisory,
  type PluginListing,
  type PluginListingVersion,
  type Publisher,
} from '@pipeline-builder/pipeline-data';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { elevated } from './store.js';

const first = <T>(rows: T[]): T | null => rows[0] ?? null;
const P = () => schema.publisher;
const L = () => schema.pluginListing;
const V = () => schema.pluginListingVersion;
const A = () => schema.pluginAdvisory;
const I = () => schema.pluginInstall;
const IP = () => schema.pluginInstallPolicy;

/** The resolver's rows, read elevated (see the module note). */
export const listingSource: ListingDataSource = {
  publisherByHandle: (handle) =>
    elevated(async (tx) => first(await tx.select().from(P()).where(eq(P().handle, handle)) as Publisher[])),
  publishersByIds: (ids) => (ids.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
    tx.select().from(P()).where(inArray(P().id, ids)) as Promise<Publisher[]>)),
  listingByName: (publisherId, name) =>
    elevated(async (tx) => first(await tx.select().from(L()).where(and(eq(L().publisherId, publisherId), eq(L().name, name))) as PluginListing[])),
  liveListings: (filter = {}) => {
    if ((filter.ids && filter.ids.length === 0) || (filter.names && filter.names.length === 0)) return Promise.resolve([]);
    return elevated(async (tx) => tx.select().from(L()).where(and(
      inArray(L().state, ['listed', 'unmaintained']),
      ...(filter.ids ? [inArray(L().id, filter.ids)] : []),
      ...(filter.names ? [inArray(L().name, filter.names)] : []),
    )) as Promise<PluginListing[]>);
  },
  versionsForListings: (ids) => (ids.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
    tx.select().from(V()).where(inArray(V().listingId, ids)) as Promise<PluginListingVersion[]>)),
  advisoriesForListings: (ids) => (ids.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
    tx.select().from(A()).where(and(inArray(A().listingId, ids), eq(A().state, 'published'))) as Promise<PluginAdvisory[]>)),
  installsForOrgs: (orgIds) => (orgIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
    tx.select().from(I()).where(inArray(I().orgId, orgIds)) as Promise<PluginInstall[]>)),
  policiesForOrgs: (orgIds) => (orgIds.length === 0 ? Promise.resolve([]) : elevated(async (tx) =>
    tx.select().from(IP()).where(inArray(IP().orgId, orgIds)) as Promise<PluginInstallPolicy[]>)),
};

export const installRows = {
  byId: (id: string): Promise<PluginInstall | null> =>
    elevated(async (tx) => first(await tx.select().from(I()).where(eq(I().id, id)) as PluginInstall[])),
  /** The org's row for a listing (any status). */
  forOrgListing: (orgId: string, listingId: string): Promise<PluginInstall | null> =>
    elevated(async (tx) => first(await tx.select().from(I()).where(and(eq(I().orgId, orgId), eq(I().listingId, listingId))) as PluginInstall[])),
  /** Every org's ACTIVE install of a listing (the "installing orgs" fan-out). */
  activeForListing: (listingId: string): Promise<PluginInstall[]> =>
    elevated(async (tx) => tx.select().from(I()).where(and(eq(I().listingId, listingId), eq(I().status, 'active'))) as Promise<PluginInstall[]>),
  /** Every org's install rows (any status) of a listing. */
  forListing: (listingId: string): Promise<PluginInstall[]> =>
    elevated(async (tx) => tx.select().from(I()).where(eq(I().listingId, listingId)) as Promise<PluginInstall[]>),
  insert: (values: PluginInstallInsert): Promise<PluginInstall> =>
    elevated(async (tx) => (await tx.insert(I()).values(values).returning())[0] as PluginInstall),
  update: (id: string, patch: Partial<PluginInstallInsert>): Promise<PluginInstall | null> =>
    elevated(async (tx) => first(await tx.update(I()).set({ ...patch, updatedAt: new Date() }).where(eq(I().id, id)).returning() as PluginInstall[])),
  /** Update only while the row is still in `status` (the approval race guard). */
  transition: (id: string, status: PluginInstall['status'], patch: Partial<PluginInstallInsert>): Promise<PluginInstall | null> =>
    elevated(async (tx) => first(await tx.update(I()).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(I().id, id), eq(I().status, status))).returning() as PluginInstall[])),
  remove: (id: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.delete(I()).where(eq(I().id, id)).returning()).length > 0),
  /** Store a pending change — only on an ACTIVE install with none pending (the race guard). */
  setPendingChange: (id: string, change: InstallChangeRequest): Promise<PluginInstall | null> =>
    elevated(async (tx) => first(await tx.update(I()).set({ pendingChange: change, updatedAt: new Date() })
      .where(and(eq(I().id, id), eq(I().status, 'active'), isNull(I().pendingChange))).returning() as PluginInstall[])),
  /** Drop a pending change (rejected). False when there was none any more. */
  clearPendingChange: (id: string): Promise<boolean> =>
    elevated(async (tx) => (await tx.update(I()).set({ pendingChange: null, updatedAt: new Date() })
      .where(and(eq(I().id, id), isNotNull(I().pendingChange))).returning()).length > 0),
  /** The org's installs with a pending change. */
  withPendingChange: (orgId: string): Promise<PluginInstall[]> =>
    elevated(async (tx) => tx.select().from(I()).where(and(eq(I().orgId, orgId), isNotNull(I().pendingChange))) as Promise<PluginInstall[]>),
};

export const policyRows = {
  get: (orgId: string): Promise<PluginInstallPolicy | null> =>
    elevated(async (tx) => first(await tx.select().from(IP()).where(eq(IP().orgId, orgId)) as PluginInstallPolicy[])),
  put: (orgId: string, values: Omit<PluginInstallPolicyInsert, 'orgId'>): Promise<PluginInstallPolicy> =>
    elevated(async (tx) => {
      const existing = first(await tx.select().from(IP()).where(eq(IP().orgId, orgId)) as PluginInstallPolicy[]);
      if (existing) {
        return (await tx.update(IP()).set({ ...values, updatedAt: new Date() }).where(eq(IP().orgId, orgId)).returning())[0] as PluginInstallPolicy;
      }
      return (await tx.insert(IP()).values({ ...values, orgId }).returning())[0] as PluginInstallPolicy;
    }),
};

type Rows<T> = { rows?: T[] } | T[];
const rowsOf = <T>(res: Rows<T>): T[] => (Array.isArray(res) ? res : res.rows ?? []);

/**
 * Orgs that use an Official listing through the IMPLICIT install (D16): a LIVE
 * pipeline's deployed step manifest records it (E8 — manifests only, no scan
 * of every pipeline definition's jsonb; a deleted pipeline never counts),
 * matched on the Official publisher's ID (E12). With `version`, only uses of
 * that exact version. Runs ACROSS orgs: the result must only ever address
 * those orgs themselves, never be shown to the publisher.
 */
export async function implicitOfficialUsers(name: string, version?: string): Promise<string[]> {
  return elevated(async (tx) => {
    const deployed = rowsOf(await tx.execute<{ org_id: string }>(sql`
      SELECT DISTINCT lower(m.org_id) AS org_id
        FROM pipeline_step_manifests m
        JOIN pipelines pl ON pl.id = m.pipeline_id AND pl.deleted_at IS NULL
        JOIN publishers pub ON pub.id = m.plugin_publisher_id AND pub.handle = ${OFFICIAL_PUBLISHER_HANDLE}
       WHERE m.plugin_name = ${name}
         ${version ? sql`AND m.plugin_version = ${version}` : sql``}
    `) as Rows<{ org_id: string }>);
    return [...new Set(deployed.map((r) => r.org_id).filter((o): o is string => !!o).map((o) => o.toLowerCase()))].sort();
  });
}

/** An org's live plugin row, as the shadowing check reads it. */
export interface OwnPluginName { id: string; name: string; orgId: string; visibility: string | null; createdBy: string | null }

/**
 * Live plugin rows named any of `names` that an UNQUALIFIED reference from
 * `orgId` would resolve before the Official listing: the org's own (a member's
 * private draft only for its author) and, for a team, its parent's `public`
 * ones (the resolution order of plan §3.5).
 */
export async function ownPluginsNamed(names: string[], scope: { orgId: string; parentOrgId?: string; userId?: string }): Promise<OwnPluginName[]> {
  if (names.length === 0) return [];
  const PL = schema.plugin;
  const orgIds = [scope.orgId.toLowerCase(), ...(scope.parentOrgId ? [scope.parentOrgId.toLowerCase()] : [])];
  const rows = await elevated(async (tx) => tx
    .select({ id: PL.id, name: PL.name, orgId: PL.orgId, visibility: PL.visibility, createdBy: PL.createdBy })
    .from(PL)
    .where(and(inArray(PL.orgId, orgIds), inArray(PL.name, names), isNull(PL.deletedAt))) as Promise<OwnPluginName[]>);
  return rows.filter((r) => (r.orgId === orgIds[0]
    ? r.visibility !== 'private' || (!!scope.userId && r.createdBy === scope.userId)
    : r.visibility === 'public'));
}
