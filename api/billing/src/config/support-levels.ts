// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The support-level catalog: ONE keyed record for the three `support_*` bundles,
 * from which every billing consumer derives its view of the ladder.
 *
 * Before this, the ladder was spelled out four times — the mutual-exclusion rank
 * in `effectiveEntitlements`, the baseline list and premium constant in the
 * support floor, and the floor's default weights — and the copies disagreed
 * about what premium IS. The floor treated it as an UPGRADE (the catalog's
 * actual shape: it grants `supportPremiumContacts` and `requiresAnyOf` a
 * baseline), while the entitlement rank treated it as a competing third level
 * and let it EVICT the baseline it was bought on top of. That dropped the
 * baseline's `supportContacts` grant and flag for every premium customer, so the
 * platform saw `level: null, limit: 0` — no case could be opened against a
 * contact seat — and the support floor returned null for the same account.
 *
 * `kind` is the distinction that was lost:
 *  - `baseline` levels replace one another (an account is on ONE baseline) and
 *    carry `rank` — higher wins when a drifted add-on set holds both.
 *  - the `upgrade` stacks ON TOP of a baseline and never competes with it.
 *
 * Bundle ids double as feature flags (`support_standard` etc. in api-core's
 * `SUPPORT_FEATURE_FLAGS`), so the keys here are those flags.
 */
export const SUPPORT_LEVELS = {
  support_standard: { kind: 'baseline', rank: 0, defaultFloorWeightPercent: 100 },
  support_priority: { kind: 'baseline', rank: 1, defaultFloorWeightPercent: 150 },
  support_premium: { kind: 'upgrade', rank: null, defaultFloorWeightPercent: 250 },
} as const satisfies Record<string, { kind: 'baseline' | 'upgrade'; rank: number | null; defaultFloorWeightPercent: number }>;

export type SupportLevelId = keyof typeof SUPPORT_LEVELS;

/** True for any of the three support bundle ids. */
export function isSupportLevel(id: string): id is SupportLevelId {
  return Object.hasOwn(SUPPORT_LEVELS, id);
}

/** The baseline levels, BEST first (descending rank). */
export const BASELINE_SUPPORT_LEVELS: readonly SupportLevelId[] = (Object.keys(SUPPORT_LEVELS) as SupportLevelId[])
  .filter((id) => SUPPORT_LEVELS[id].kind === 'baseline')
  .sort((a, b) => (SUPPORT_LEVELS[b].rank ?? 0) - (SUPPORT_LEVELS[a].rank ?? 0));

/** The premium upgrade, named once. */
export const PREMIUM_SUPPORT_LEVEL: SupportLevelId = 'support_premium';
