// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The views of the in-app catalog and an org's installs: install state, upgrades, notes, the catalog entry. */

import {
  advisoriesCovering,
  compareSemver,
  installAdmits,
  listedVersionWarnings,
  OFFICIAL_PUBLISHER_HANDLE,
  parseSemver,
  type ConsumptionPolicy,
  type InstallVersionPolicy,
  type OrgListingState,
  type PluginAdvisory,
  type PluginInstall,
  type PluginListing,
  type PluginListingVersion,
  type Publisher,
} from '@pipeline-builder/pipeline-data';

import { can, type Caller } from './context.js';
import { vulnDelta } from './policy.js';
import { listingStats } from './reviews-store.js';
import { iso, roundTo } from './util.js';

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

/** Why an org can't use a listing right now (policy, state, or an advisory on every candidate). */
export interface BlockedInfo { reason: 'tier' | 'blocked_listing' | 'advisory' | 'suspended'; message: string }

function blockedOf(state: OrgListingState): BlockedInfo | null {
  if (state.block) return { reason: state.block.reason, message: state.block.message };
  if (state.refusal?.reason === 'advisory') return { reason: 'advisory', message: state.refusal.message };
  return null;
}

const isLive = (v: PluginListingVersion) => !v.yankedAt;
export const isStable = (v: string) => (parseSemver(v)?.prerelease.length ?? 1) === 0;

/** The newest live stable version OUTSIDE the org's install range (an upgrade), with its changelog and vuln delta. */
function upgradeOf(state: OrgListingState) {
  if ('code' in state.mode) return null;
  const mode = state.mode;
  const current = state.resolved;
  const candidates = state.versions.filter((v) => isLive(v) && !v.pausedAt && isStable(v.version)
    && (!current || compareSemver(v.version, current.version) > 0)
    && (mode.kind === 'explicit' ? !installAdmits(mode.install, v.version, state.versions) : true)
    && v.id !== current?.id);
  const next = candidates.reduce<PluginListingVersion | null>((best, v) => (best === null || compareSemver(v.version, best.version) > 0 ? v : best), null);
  if (!next) return null;
  const crossed = state.versions.some((v) => v.breaking && (!current || compareSemver(v.version, current.version) > 0) && compareSemver(v.version, next.version) <= 0);
  return {
    version: next.version,
    breaking: crossed || (!!current && parseSemver(next.version)?.major !== parseSemver(current.version)?.major),
    changelog: next.changelog,
    vulnDelta: vulnDelta(current ? { critical: current.vulnCritical, high: current.vulnHigh } : null, { critical: next.vulnCritical, high: next.vulnHigh }),
  };
}

/** The API view of an install — explicit (any status) or implicit (virtual, `id: null`). */
export function installView(state: OrgListingState, ownOrgId: string) {
  const { publisher, listing } = state;
  const explicit = !('code' in state.mode) && state.mode.kind === 'explicit' ? state.mode : null;
  const row: PluginInstall | null = explicit?.install ?? state.ownInstall;
  const implicit = !row && !('code' in state.mode) && state.mode.kind === 'implicit';
  return {
    id: row?.id ?? null,
    listingId: listing.id,
    publisherHandle: publisher.handle,
    publisherDisplayName: publisher.displayName,
    publisherTier: publisher.tier,
    name: listing.name,
    summary: listing.summary,
    category: listing.category,
    icon: listing.icon ?? null,
    state: listing.state,
    paused: listing.pausedAt !== null,
    versionPolicy: (row?.versionPolicy ?? 'minor') as InstallVersionPolicy,
    pinnedVersion: row?.pinnedVersion ?? null,
    resolvedVersion: state.resolved?.version ?? null,
    latestVersion: listing.latestVersion,
    status: row?.status ?? 'active',
    implicit,
    inherited: !!row && row.orgId.toLowerCase() !== ownOrgId.toLowerCase(),
    installedBy: row?.installedBy ?? null,
    approvedBy: row?.approvedBy ?? null,
    createdAt: iso(row?.createdAt),
    decidedAt: iso(row?.decidedAt),
    /** The member's pending, approval-gated change (target version + policy), or null. */
    pendingChange: row?.pendingChange ?? null,
    upgrade: upgradeOf(state),
    blocked: blockedOf(state),
    ...installNotes(state),
  };
}
export type InstallView = ReturnType<typeof installView>;

/**
 * What an install's resolved version carries: the lookup warnings
 * (advisory, deprecation, unmaintained, withheld secrets) and the PUBLISHED
 * advisories covering it — or, when an advisory BLOCKS resolution, the
 * blocking ones on the newest version the install would otherwise take.
 */
function installNotes(state: OrgListingState) {
  const brief = (a: Pick<PluginAdvisory, 'id' | 'severity' | 'summary' | 'fixedVersion'>, blocking: boolean) =>
    ({ id: a.id, severity: a.severity, summary: a.summary, fixedVersion: a.fixedVersion, blocking });
  if (state.resolved) {
    const { warnings } = listedVersionWarnings({ publisher: state.publisher, listing: state.listing, version: state.resolved, advisories: state.advisories, policy: state.policy });
    const advisories = advisoriesCovering(state.advisories, state.resolved.version).map((a) => brief(a, false));
    return { warnings, advisories };
  }
  if (state.refusal?.reason === 'advisory') {
    const ids = new Set(((state.refusal.details?.advisories as string[] | undefined) ?? []));
    return { warnings: [], advisories: state.advisories.filter((a) => ids.has(a.id)).map((a) => brief(a, true)) };
  }
  return { warnings: [], advisories: [] };
}

function listingSummary(publisher: Publisher, listing: PluginListing) {
  return {
    id: listing.id,
    publisherHandle: publisher.handle,
    publisherDisplayName: publisher.displayName,
    publisherTier: publisher.tier,
    name: listing.name,
    summary: listing.summary,
    category: listing.category,
    icon: listing.icon ?? null,
    latestVersion: listing.latestVersion,
    state: listing.state,
    paused: listing.pausedAt !== null,
    license: listing.license,
  };
}

function resolvedInfo(v: PluginListingVersion | null, listing: PluginListing) {
  if (!v) return null;
  const s = (v.specSnapshot ?? {}) as Record<string, unknown>;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.map((e) => (typeof e === 'string' ? e : (e as { name?: string })?.name)).filter((e): e is string => typeof e === 'string') : []);
  return {
    version: v.version,
    pluginType: typeof s.pluginType === 'string' ? s.pluginType : null,
    computeType: typeof s.computeType === 'string' ? s.computeType : null,
    primaryOutputDirectory: typeof s.primaryOutputDirectory === 'string' ? s.primaryOutputDirectory : null,
    description: typeof s.description === 'string' ? s.description : listing.description,
    requiredMetadata: strings(s.requiredMetadata),
    requiredVars: strings(s.requiredVars),
    secrets: strings(s.secrets),
  };
}

/** Whether installing would create a pending request for this caller. */
export function needsApproval(caller: Caller, policy: ConsumptionPolicy, tier: Publisher['tier']): boolean {
  return policy.requireApprovalTiers.includes(tier) && !can(caller, 'plugin_installs:manage');
}

/** The catalog entry for one listing: the listing, the org's standing, and the reference to write. */
export function catalogEntry(caller: Caller, state: OrgListingState, policy: ConsumptionPolicy, shadowIds: string[]) {
  const install = !('code' in state.mode) || state.ownInstall ? installView(state, caller.orgId) : null;
  const blocked = blockedOf(state);
  const official = state.publisher.handle === OFFICIAL_PUBLISHER_HANDLE;
  const hasOwnRow = !!state.ownInstall;
  const shadowed = official && shadowIds.length > 0;
  return {
    listing: listingSummary(state.publisher, state.listing),
    install,
    installable: !blocked && state.listing.pausedAt === null && !hasOwnRow && can(caller, 'plugins:install'),
    // This caller needs an approver for the listing's tier: installing it
    // becomes a request, and moving an install across a major/breaking
    // version or to `latest` is refused without one (updateInstall).
    needsApproval: needsApproval(caller, policy, state.publisher.tier),
    blocked,
    resolved: resolvedInfo(state.resolved, state.listing),
    reference: official && !shadowed ? { name: state.listing.name } : { publisher: state.publisher.handle, name: state.listing.name },
    shadowedBy: shadowed ? { pluginIds: shadowIds } : null,
  };
}
export type CatalogEntry = ReturnType<typeof catalogEntry>;

interface ListingStatsSummary {
  rating: { score: number; count: number } | null;
  installCount: number;
  /** 0–100 health score, null until the sweep has enough data. */
  healthScore: number | null;
}

/** Each listing's public rating, install count and health score (plugin_stats), for the in-app catalog. */
export async function statsFor(listingIds: string[]): Promise<Map<string, ListingStatsSummary>> {
  const rows = await listingStats.byListings(listingIds);
  return new Map(rows.map((s) => [s.listingId, {
    rating: s.ratingCount > 0 && s.ratingBayes !== null ? { score: roundTo(s.ratingBayes, 2), count: s.ratingCount } : null,
    installCount: s.installCount,
    healthScore: s.healthScore === null || s.healthScore === undefined ? null : Math.round(s.healthScore),
  }]));
}
export const NO_STATS: ListingStatsSummary = { rating: null, installCount: 0, healthScore: null };
