// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for plugin installs and the org consumption policy
 * (docs/plans/plugin-ecosystem.md §3.1 D16, §3.2, §3.5 — W2): which install
 * action a listing offers, the plugin-usage key of a reference, and the
 * consumption-policy form's draft logic. No React, no I/O — tested directly.
 */

import type { Plugin } from '@/types';
import type { PublisherTier } from '@/types/ecosystem';
import type {
  BlockedInfo, CatalogEntry, ConsumptionPolicy, InstallStatus, InstallView, PluginReference, VersionPolicy,
} from '@/types/plugin-installs';

/** The Official publisher's handle (the system org's catalog). */
export const OFFICIAL_PUBLISHER_HANDLE = 'pipeline-builder';

export const PUBLISHER_TIERS: readonly PublisherTier[] = ['official', 'verified', 'community', 'unverified'];

export const PUBLISHER_TIER_LABELS: Record<PublisherTier, string> = {
  official: 'Official',
  verified: 'Verified',
  community: 'Community',
  unverified: 'Community · unverified',
};

export const VERSION_POLICIES: readonly VersionPolicy[] = ['pinned', 'patch', 'minor', 'latest'];

export const VERSION_POLICY_LABELS: Record<VersionPolicy, string> = {
  pinned: 'Pinned (exact version)',
  patch: 'Patch updates (~)',
  minor: 'Minor updates (^)',
  latest: 'Latest (never crosses a breaking version)',
};

export const INSTALL_STATUS_LABELS: Record<InstallStatus, string> = {
  active: 'Installed',
  pending_approval: 'Pending approval',
  denied: 'Denied',
};

export const BLOCKED_REASON_LABELS: Record<BlockedInfo['reason'], string> = {
  tier: 'Publisher tier not allowed by your organization',
  blocked_listing: 'Blocked by your organization',
  advisory: 'Blocked by a security advisory',
  suspended: 'Suspended',
};

/** The default consumption policy (§3.2), used before the server answers. */
export const DEFAULT_CONSUMPTION_POLICY: ConsumptionPolicy = {
  allowedTiers: ['official', 'verified'],
  requireApprovalTiers: ['community', 'unverified'],
  secretsAllowedTiers: ['official', 'verified'],
  blockOnAdvisory: 'critical',
  officialInstalls: 'implicit',
  blockedListings: [],
};

// ---------------------------------------------------------------------------
// References and usage
// ---------------------------------------------------------------------------

/**
 * The key `GET /plugins/plugin-usage` counts a reference under: `name` for an
 * unqualified reference, `publisher/name` for a qualified one.
 */
export function pluginUsageKey(ref: { publisher?: string | null; name: string }): string {
  return ref.publisher ? `${ref.publisher}/${ref.name}` : ref.name;
}

/**
 * How many of the org's pipelines use a listing. An Official listing that is
 * NOT shadowed also answers to its bare name (the implicit install), so both
 * keys count; a shadowed one only answers to its qualified name (the bare name
 * resolves to the org's own plugin).
 */
export function listingUsage(
  listing: { publisherHandle: string; name: string },
  counts: Record<string, number>,
  opts: { shadowed?: boolean } = {},
): number {
  const qualified = counts[pluginUsageKey({ publisher: listing.publisherHandle, name: listing.name })] ?? 0;
  const bare = listing.publisherHandle === OFFICIAL_PUBLISHER_HANDLE && !opts.shadowed ? (counts[listing.name] ?? 0) : 0;
  return qualified + bare;
}

/** A pipeline reference as a string (`acme/terraform-plan` or `trivy`). */
export function formatReference(ref: PluginReference): string {
  return pluginUsageKey(ref);
}

/** Parse `publisher/name` (the blocked-listings input). Null when malformed. */
export function parseListingRef(input: string): { publisher: string; name: string } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*\/\s*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*$/.exec(input);
  return m ? { publisher: m[1], name: m[2] } : null;
}

/** Catalog entries a pipeline step can reference now: something resolves and nothing blocks it. */
export function resolvableEntries(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return entries.filter((e) => e.resolved !== null && !e.blocked);
}

/** The shadowing warning shown on an own plugin and next to the pipeline editor's picker. */
export function shadowingMessage(name: string, publisher: string = OFFICIAL_PUBLISHER_HANDLE): string {
  return `Shadows the Official listing ${publisher}/${name}: pipelines that reference \`${name}\` use this plugin.`;
}

// ---------------------------------------------------------------------------
// Install action state
// ---------------------------------------------------------------------------

export type InstallActionState =
  /** Already installed (explicit). `upgrade` is the newest version outside the range. */
  | { kind: 'installed'; install: InstallView }
  /** The virtual Official install (D16); pinning creates an explicit install. */
  | { kind: 'implicit'; install: InstallView }
  | { kind: 'pending'; install: InstallView }
  | { kind: 'denied'; install: InstallView }
  | { kind: 'blocked'; blocked: BlockedInfo }
  | { kind: 'paused' }
  /** May be installed now; `requiresApproval` = it would become a request. */
  | { kind: 'install'; requiresApproval: boolean }
  /** Not installable for a reason the server did not name. */
  | { kind: 'unavailable' };

/** What a listing offers this org, from its catalog entry. */
export function installActionState(entry: CatalogEntry): InstallActionState {
  const install = entry.install;
  if (install) {
    if (install.status === 'pending_approval') return { kind: 'pending', install };
    if (install.status === 'denied') return { kind: 'denied', install };
    if (install.implicit || install.id === null) return { kind: 'implicit', install };
    return { kind: 'installed', install };
  }
  if (entry.blocked) return { kind: 'blocked', blocked: entry.blocked };
  if (entry.listing.paused) return { kind: 'paused' };
  if (entry.installable) return { kind: 'install', requiresApproval: entry.requiresApproval };
  return { kind: 'unavailable' };
}

// ---------------------------------------------------------------------------
// Consumption-policy form
// ---------------------------------------------------------------------------

export type TierListKey = 'allowedTiers' | 'requireApprovalTiers' | 'secretsAllowedTiers';

/** Toggle a tier in one of the policy's tier lists, keeping the canonical tier order. */
export function toggleTier(list: readonly PublisherTier[], tier: PublisherTier, on: boolean): PublisherTier[] {
  const set = new Set(list);
  if (on) set.add(tier); else set.delete(tier);
  return PUBLISHER_TIERS.filter((t) => set.has(t));
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function listingKey(l: { publisher: string; name: string }): string {
  return `${l.publisher}/${l.name}`;
}

/** Add a blocked listing (deduplicated). */
export function addBlockedListing(
  list: ConsumptionPolicy['blockedListings'],
  item: { publisher: string; name: string },
): ConsumptionPolicy['blockedListings'] {
  return list.some((l) => listingKey(l) === listingKey(item)) ? list : [...list, item];
}

export function removeBlockedListing(
  list: ConsumptionPolicy['blockedListings'],
  item: { publisher: string; name: string },
): ConsumptionPolicy['blockedListings'] {
  return list.filter((l) => listingKey(l) !== listingKey(item));
}

/** The fields the draft changed against the saved policy (the PUT body); empty when clean. */
export function diffPolicy(saved: ConsumptionPolicy, draft: ConsumptionPolicy): Partial<ConsumptionPolicy> {
  const out: Partial<ConsumptionPolicy> = {};
  for (const key of ['allowedTiers', 'requireApprovalTiers', 'secretsAllowedTiers'] as const) {
    if (!sameSet(saved[key], draft[key])) out[key] = draft[key];
  }
  if (saved.blockOnAdvisory !== draft.blockOnAdvisory) out.blockOnAdvisory = draft.blockOnAdvisory;
  if (saved.officialInstalls !== draft.officialInstalls) out.officialInstalls = draft.officialInstalls;
  if (!sameSet(saved.blockedListings.map(listingKey), draft.blockedListings.map(listingKey))) {
    out.blockedListings = draft.blockedListings;
  }
  return out;
}

/**
 * Human-readable notes about a draft that is legal but likely a mistake. The
 * server is the authority on what it accepts (and on team inheritance, where a
 * team can only be stricter); these only explain the consequence up front.
 */
export function policyWarnings(draft: ConsumptionPolicy): string[] {
  const out: string[] = [];
  if (!draft.allowedTiers.includes('official')) {
    out.push('Official plugins are not allowed: pipelines that use Official plugins (including the built-in catalog) will stop resolving them.');
  }
  const secretsOutside = draft.secretsAllowedTiers.filter((t) => !draft.allowedTiers.includes(t));
  if (secretsOutside.length > 0) {
    out.push(`Secrets for ${secretsOutside.map((t) => PUBLISHER_TIER_LABELS[t]).join(', ')} have no effect: those tiers are not allowed at all.`);
  }
  if (draft.officialInstalls === 'explicit') {
    out.push('Official plugins must be installed deliberately: pipelines that reference an Official plugin that is not installed will fail to synth.');
  }
  if (draft.blockOnAdvisory === 'never') {
    out.push('Plugins with an active security advisory will keep resolving.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline editor picker
// ---------------------------------------------------------------------------

/** A catalog entry's picker query match (name, publisher, summary, category). */
export function filterCatalogEntries(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => [e.listing.name, e.listing.publisherHandle, e.listing.publisherDisplayName, e.listing.summary ?? '', e.listing.category]
    .some((v) => v.toLowerCase().includes(q)));
}

/**
 * The picker's listing groups: Official first, then everything else installed
 * from the catalog. Only resolvable entries (something resolves, nothing
 * blocks) — the picker offers what a synth can actually use.
 */
export function groupCatalogEntries(entries: readonly CatalogEntry[], query: string): Array<{ label: string; entries: CatalogEntry[] }> {
  const usable = filterCatalogEntries(resolvableEntries(entries), query)
    .sort((a, b) => a.listing.name.localeCompare(b.listing.name));
  const official = usable.filter((e) => e.listing.publisherTier === 'official');
  const others = usable.filter((e) => e.listing.publisherTier !== 'official');
  return [
    ...(official.length ? [{ label: 'Official', entries: official }] : []),
    ...(others.length ? [{ label: 'Installed from the catalog', entries: others }] : []),
  ];
}

/**
 * Is an UNQUALIFIED reference to `name` shadowed — i.e. an own-org plugin wins
 * over the Official listing of the same name? Qualified references never are.
 */
export function shadowedListing(
  ref: { publisher?: string | null; name: string },
  shadowing: ReadonlyArray<{ name: string; listing: { publisherHandle: string; name: string } }>,
): { publisherHandle: string; name: string } | null {
  if (ref.publisher || !ref.name) return null;
  return shadowing.find((s) => s.name === ref.name)?.listing ?? null;
}

/** What the pipeline editor's plugin picker hands back: an own plugin row or a catalog listing. */
export type PluginPick =
  | { kind: 'plugin'; plugin: Plugin }
  | { kind: 'listing'; entry: CatalogEntry };

/** The name a pick writes into the reference. */
export function pickName(pick: PluginPick): string {
  return pick.kind === 'plugin' ? pick.plugin.name : pick.entry.reference.name;
}

/**
 * Apply a picker selection to a (generated) pipeline plugin reference in place:
 * an own plugin pins its row through `filter` and drops any publisher; a
 * listing writes `{ publisher?, name }` and drops the own-row filter (a listing
 * resolves through the org's install). Either way the alias is cleared.
 */
export function applyPluginPick(
  target: { publisher?: string; name: string; alias?: string; filter?: Record<string, unknown> },
  pick: PluginPick,
): void {
  target.alias = undefined;
  if (pick.kind === 'listing') {
    const { reference } = pick.entry;
    target.name = reference.name;
    if (reference.publisher) target.publisher = reference.publisher; else delete target.publisher;
    delete target.filter;
    return;
  }
  const { plugin } = pick;
  target.name = plugin.name;
  delete target.publisher;
  target.filter = {
    id: plugin.id,
    orgId: plugin.orgId,
    version: plugin.version,
    visibility: plugin.visibility,
    isDefault: plugin.isDefault,
    isActive: plugin.isActive,
  };
}

/**
 * A catalog entry for an install row (the Installs and Approvals tabs), so the
 * shared install controls drive both. Not installable (it already is), and no
 * resolved contract — the install list doesn't carry one.
 */
export function entryFromInstall(install: InstallView): CatalogEntry {
  return {
    listing: {
      id: install.listingId,
      publisherHandle: install.publisherHandle,
      publisherDisplayName: install.publisherDisplayName,
      publisherTier: install.publisherTier,
      name: install.name,
      summary: install.summary,
      category: install.category,
      icon: install.icon,
      latestVersion: install.latestVersion,
      state: install.state,
      paused: install.paused,
      license: null,
    },
    install,
    needsApproval: install.needsApproval ?? false,
    installable: false,
    requiresApproval: false,
    blocked: install.blocked,
    resolved: null,
    reference: install.publisherHandle === OFFICIAL_PUBLISHER_HANDLE
      ? { name: install.name }
      : { publisher: install.publisherHandle, name: install.name },
    shadowedBy: null,
    // The install list carries no directory stats.
    rating: null,
    installCount: 0,
  };
}
