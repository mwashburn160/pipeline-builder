// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An org's plugin CONSUMPTION POLICY: which publisher tiers it trusts, which
 * listings it blocks, which advisory severities block a resolution, and which
 * tiers may receive secrets. Applied at every resolution (see
 * ./plugin-resolution.ts) and edited through the org's policy row.
 *
 * Pure functions over the stored row — no I/O — so the same rules run in the
 * resolver, in the policy-update route, and in tests.
 */

import {
  type BlockedListingRef,
  type BlockOnAdvisory,
  type OfficialInstalls,
  type PluginInstallPolicy,
  type PublisherTier,
  PUBLISHER_TIERS,
} from '../database/drizzle-schema.js';


/** An org's consumption policy, as the resolver applies it. */
export interface ConsumptionPolicy {
  allowedTiers: PublisherTier[];
  requireApprovalTiers: PublisherTier[];
  secretsAllowedTiers: PublisherTier[];
  blockOnAdvisory: BlockOnAdvisory;
  officialInstalls: OfficialInstalls;
  blockedListings: BlockedListingRef[];
}

/** The defaults (and the column defaults of `plugin_install_policies`). */
export const DEFAULT_CONSUMPTION_POLICY: Readonly<ConsumptionPolicy> = Object.freeze<ConsumptionPolicy>({
  allowedTiers: ['official', 'verified'],
  requireApprovalTiers: ['community', 'unverified'],
  secretsAllowedTiers: ['official', 'verified'],
  blockOnAdvisory: 'critical',
  officialInstalls: 'implicit',
  blockedListings: [],
});

/** At most this many blocked listings per policy. */
export const MAX_BLOCKED_LISTINGS = 500;

const BLOCK_ORDER: readonly BlockOnAdvisory[] = ['never', 'critical', 'high'];

const sortTiers = (tiers: Iterable<PublisherTier>): PublisherTier[] =>
  PUBLISHER_TIERS.filter((t) => new Set(tiers).has(t));

const listingKey = (r: BlockedListingRef): string => `${r.publisher}/${r.name}`;

function uniqueListings(refs: readonly BlockedListingRef[]): BlockedListingRef[] {
  const seen = new Map<string, BlockedListingRef>();
  for (const r of refs) seen.set(listingKey(r), { publisher: r.publisher, name: r.name });
  return [...seen.values()].sort((a, b) => listingKey(a).localeCompare(listingKey(b)));
}

/** A stored policy row (or none) as a {@link ConsumptionPolicy}. */
export function policyOf(row: Partial<PluginInstallPolicy> | null | undefined): ConsumptionPolicy {
  const d = DEFAULT_CONSUMPTION_POLICY;
  return {
    allowedTiers: sortTiers(row?.allowedTiers ?? d.allowedTiers),
    requireApprovalTiers: sortTiers(row?.requireApprovalTiers ?? d.requireApprovalTiers),
    secretsAllowedTiers: sortTiers(row?.secretsAllowedTiers ?? d.secretsAllowedTiers),
    blockOnAdvisory: row?.blockOnAdvisory ?? d.blockOnAdvisory,
    officialInstalls: row?.officialInstalls ?? d.officialInstalls,
    blockedListings: uniqueListings(row?.blockedListings ?? d.blockedListings),
  };
}

/**
 * A team's policy under its root org's: each field takes the STRICTER of
 * the two, so a team can narrow what its root allows but never widen it.
 */
export function mergeConsumptionPolicies(root: ConsumptionPolicy, team: ConsumptionPolicy): ConsumptionPolicy {
  const intersect = (a: PublisherTier[], b: PublisherTier[]) => sortTiers(a.filter((t) => b.includes(t)));
  const union = (a: PublisherTier[], b: PublisherTier[]) => sortTiers([...a, ...b]);
  const stricterBlock = BLOCK_ORDER.indexOf(root.blockOnAdvisory) >= BLOCK_ORDER.indexOf(team.blockOnAdvisory)
    ? root.blockOnAdvisory : team.blockOnAdvisory;
  return {
    allowedTiers: intersect(root.allowedTiers, team.allowedTiers),
    requireApprovalTiers: union(root.requireApprovalTiers, team.requireApprovalTiers),
    secretsAllowedTiers: intersect(root.secretsAllowedTiers, team.secretsAllowedTiers),
    blockOnAdvisory: stricterBlock,
    officialInstalls: root.officialInstalls === 'explicit' || team.officialInstalls === 'explicit' ? 'explicit' : 'implicit',
    blockedListings: uniqueListings([...root.blockedListings, ...team.blockedListings]),
  };
}

/**
 * The policy an org's resolution runs under. A root org: its own row (or the
 * defaults). A team (`rootOrgId` set): its root's policy, merged with the
 * team's own row when it has one.
 */
export function effectiveConsumptionPolicy(
  rows: ReadonlyArray<Partial<PluginInstallPolicy> & { orgId?: string }>,
  orgId: string,
  rootOrgId?: string,
): ConsumptionPolicy {
  const own = rows.find((r) => r.orgId === orgId) ?? null;
  if (!rootOrgId || rootOrgId === orgId) return policyOf(own);
  const root = policyOf(rows.find((r) => r.orgId === rootOrgId) ?? null);
  return own ? mergeConsumptionPolicies(root, policyOf(own)) : root;
}

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function tierList(v: unknown, field: string): PublisherTier[] | string {
  if (!Array.isArray(v)) return `${field} must be an array of tiers`;
  const bad = v.filter((t) => !(PUBLISHER_TIERS as readonly unknown[]).includes(t));
  if (bad.length) return `${field} has unknown tiers: ${bad.map(String).join(', ')}`;
  return sortTiers(v as PublisherTier[]);
}

/**
 * Validate a (partial) policy update over `base`. Returns the full new policy,
 * or an error message. `blockedListings` entries are `{ publisher, name }` or
 * `"publisher/name"`.
 */
export function applyPolicyUpdate(base: ConsumptionPolicy, input: unknown): ConsumptionPolicy | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'body must be an object';
  const b = input as Record<string, unknown>;
  const next: ConsumptionPolicy = { ...base };
  for (const field of ['allowedTiers', 'requireApprovalTiers', 'secretsAllowedTiers'] as const) {
    if (b[field] === undefined) continue;
    const tiers = tierList(b[field], field);
    if (typeof tiers === 'string') return tiers;
    next[field] = tiers;
  }
  if (b.blockOnAdvisory !== undefined) {
    if (!BLOCK_ORDER.includes(b.blockOnAdvisory as BlockOnAdvisory)) return 'blockOnAdvisory must be critical, high or never';
    next.blockOnAdvisory = b.blockOnAdvisory as BlockOnAdvisory;
  }
  if (b.officialInstalls !== undefined) {
    if (b.officialInstalls !== 'implicit' && b.officialInstalls !== 'explicit') return 'officialInstalls must be implicit or explicit';
    next.officialInstalls = b.officialInstalls;
  }
  if (b.blockedListings !== undefined) {
    if (!Array.isArray(b.blockedListings)) return 'blockedListings must be an array';
    if (b.blockedListings.length > MAX_BLOCKED_LISTINGS) return `at most ${MAX_BLOCKED_LISTINGS} blocked listings`;
    const refs: BlockedListingRef[] = [];
    for (const raw of b.blockedListings) {
      const ref = typeof raw === 'string'
        ? (() => { const [publisher, name, extra] = raw.split('/'); return extra === undefined ? { publisher, name } : null; })()
        : raw && typeof raw === 'object' ? { publisher: (raw as BlockedListingRef).publisher, name: (raw as BlockedListingRef).name } : null;
      if (!ref || typeof ref.publisher !== 'string' || typeof ref.name !== 'string'
        || !HANDLE_RE.test(ref.publisher) || !NAME_RE.test(ref.name)) {
        return 'each blocked listing must be { publisher, name } (or "publisher/name")';
      }
      refs.push({ publisher: ref.publisher, name: ref.name });
    }
    next.blockedListings = uniqueListings(refs);
  }
  return next;
}
