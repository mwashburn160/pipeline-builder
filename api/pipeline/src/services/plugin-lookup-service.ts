// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  buildPluginConditions, drizzleListingSource, getTenantContext, OFFICIAL_PUBLISHER_HANDLE, resolvableListings, runWithTenantContext, schema,
  withTenantTx, withViewerContext, type PluginFilter,
} from '@pipeline-builder/pipeline-data';
import { and, inArray, isNull, type SQL } from 'drizzle-orm';

/**
 * Visibility predicate for the active plugins the CALLER can see — the shared
 * three-rung `visibility` ladder (see `AccessControlQueryBuilder.buildAccessControl`),
 * not a bespoke copy of it:
 *
 *   - own org: `org` + `public` rows, plus the caller's OWN `private` drafts
 *     (another member's private plugin stays invisible);
 *   - system org: `public` rows (the shared catalog every org sees).
 *
 * The viewer (user id / super-admin) is stamped from the request's tenant
 * context by `withViewerContext`, so this must run inside the request scope;
 * outside one the private rung fails closed (matches nothing).
 *
 * Shared by every read path in this service that needs the "what plugins can
 * this caller see?" filter (AI generation context + auto-create existence check).
 */
export function availablePluginConditions(orgId: string): SQL[] {
  return [
    ...buildPluginConditions(withViewerContext<PluginFilter>({}), orgId),
    isNull(schema.plugin.deletedAt),
  ];
}

/** A listed plugin the org's references resolve right now (see docs/plugin-installing.md). */
export interface ResolvableListing {
  publisher: string;
  tier: string;
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  category: string;
  spec: Record<string, unknown>;
  deprecated: boolean;
  /** Publisher-paused (no new installs; existing installs still resolve). */
  paused: boolean;
  /** The listing is `unmaintained` (still public, shown with a banner). */
  unmaintained: boolean;
  /** Bayesian rating (plugin_stats), null until someone rated it. */
  ratingBayes: number | null;
  /** 0–100 health score, null until the stats sweep has enough data. */
  healthScore: number | null;
}

/**
 * The listings the caller's references resolve now: explicitly installed ones
 * (the org's own or, for a team, its root org's) and the implicit Official
 * ones, minus what the consumption policy blocks (the shared resolver in
 * pipeline-data). `names` narrows it. Read elevated — the ecosystem tables and
 * a team's root-org install rows — and scoped by the explicit org ids.
 */
export async function findResolvableListings(orgId: string, names?: string[]): Promise<ResolvableListing[]> {
  const parentOrgId = getTenantContext()?.parentOrgId;
  const scope = { orgId, ...(parentOrgId ? { rootOrgId: parentOrgId } : {}) };
  const states = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) =>
    resolvableListings(drizzleListingSource(tx), scope, names ? { names } : {})));
  const stats = await listingQuality(states.map((s) => s.listing.id));
  return states.map((s) => {
    const spec = (s.resolved.specSnapshot ?? {}) as Record<string, unknown>;
    const q = stats.get(s.listing.id);
    return {
      publisher: s.publisher.handle,
      tier: s.publisher.tier,
      name: s.listing.name,
      version: s.resolved.version,
      description: (typeof spec.description === 'string' ? spec.description : null) ?? s.listing.summary,
      keywords: s.listing.keywords ?? [],
      category: s.listing.category,
      spec,
      deprecated: s.resolved.deprecatedAt !== null,
      paused: s.listing.pausedAt != null,
      unmaintained: s.listing.state === 'unmaintained',
      ratingBayes: q && q.ratingCount > 0 && q.ratingBayes !== null ? Math.round(q.ratingBayes * 100) / 100 : null,
      healthScore: q?.healthScore === null || q?.healthScore === undefined ? null : Math.round(q.healthScore),
    };
  });
}

/** Rating + health (plugin_stats) per listing id. Instance-wide rows, read elevated. */
async function listingQuality(listingIds: string[]): Promise<Map<string, { ratingBayes: number | null; ratingCount: number; healthScore: number | null }>> {
  if (listingIds.length === 0) return new Map();
  const S = schema.pluginStats;
  const rows = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx
    .select({ listingId: S.listingId, ratingBayes: S.ratingBayes, ratingCount: S.ratingCount, healthScore: S.healthScore })
    .from(S)
    .where(inArray(S.listingId, listingIds))));
  return new Map(rows.map((r) => [r.listingId, r]));
}

/**
 * Return the subset of `names` an UNQUALIFIED reference from the caller
 * already resolves: an active plugin row the caller can see (see
 * {@link availablePluginConditions}), or an Official listing the org reaches
 * through its (implicit or explicit) install. One round-trip for the rows.
 */
export async function findExistingPluginNames(names: string[], orgId: string): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  // Wrap in withTenantTx so `app.org_id` is set — the `plugins` table is
  // FORCE ROW LEVEL SECURITY, and a bare `db.select()` runs with a null GUC,
  // collapsing the policy to system-org rows only and dropping the org's own.
  const rows = await withTenantTx(async (tx) => tx
    .select({ name: schema.plugin.name })
    .from(schema.plugin)
    .where(and(inArray(schema.plugin.name, names), ...availablePluginConditions(orgId))));
  const official = (await findResolvableListings(orgId, names)).filter((l) => l.publisher === OFFICIAL_PUBLISHER_HANDLE);

  return new Set([...rows.map((r) => r.name), ...official.map((l) => l.name)]);
}

/**
 * The subset of `names` that are LISTED by any publisher (live listings): an
 * auto-created placeholder must never take such a name — the listing
 * is the plugin, and the org should install it instead.
 */
export async function findListedNames(names: string[]): Promise<Map<string, string[]>> {
  if (names.length === 0) return new Map();
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(async (tx) => {
    const source = drizzleListingSource(tx);
    const listings = await source.liveListings({ names });
    const publishers = await source.publishersByIds([...new Set(listings.map((l) => l.publisherId))]);
    const out = new Map<string, string[]>();
    for (const l of listings) {
      const handle = publishers.find((p) => p.id === l.publisherId)?.handle;
      if (handle) out.set(l.name, [...(out.get(l.name) ?? []), handle].sort());
    }
    return out;
  }));
}
