// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the four quota tiers' display metadata
 * (label, color classes, sort order). Consolidates copies that lived in
 * dashboard/quotas.tsx, dashboard/billing.tsx, and admin/orgs/[orgId].tsx.
 * Adding a new tier here updates every UI surface in one place.
 */
import type { BadgeColor } from '@/components/ui/Badge';
import type { QuotaTier } from '@pipeline-builder/api-core';

/** The quota tiers, straight from the backend's own enum — never a local copy,
 *  which is how `unlimited` (the DEFAULT when billing is off) kept getting
 *  dropped from tier unions around the app. */
export type TierKey = QuotaTier;

export interface TierMeta {
  /** Lowercase enum key as stored by the quota service. */
  readonly key: TierKey;
  /** Human-readable label (Title Case). */
  readonly label: string;
  /** Tailwind classes for a coloured pill (background + text). */
  readonly pillClass: string;
  /** Tailwind classes for a coloured dot. */
  readonly dotClass: string;
  /** `<Badge color>` for this tier, so a tier pill in a table can't fall back
   *  to developer's colour for a tier the call site forgot about. */
  readonly badgeColor: BadgeColor;
  /** Stable display order: developer < pro < team < enterprise. */
  readonly sort: number;
}

export const TIER_META: Record<TierKey, TierMeta> = {
  developer: {
    key: 'developer',
    label: 'Developer',
    pillClass: 'bg-info-bg text-info-strong',
    dotClass: 'bg-blue-500',
    badgeColor: 'gray',
    sort: 0,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    pillClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    dotClass: 'bg-purple-500',
    badgeColor: 'purple',
    sort: 1,
  },
  team: {
    key: 'team',
    label: 'Team',
    pillClass: 'bg-success-bg text-success-strong',
    dotClass: 'bg-emerald-500',
    badgeColor: 'green',
    sort: 2,
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    pillClass: 'bg-warning-bg text-warning-strong',
    dotClass: 'bg-amber-500',
    badgeColor: 'red',
    sort: 3,
  },
  // Billing-DISABLED default tier: everything uncapped. Meta exists so an org on
  // this tier renders correctly, but it's intentionally NOT in TIER_KEYS — never
  // offered as a selectable/purchasable tier when billing is enabled.
  unlimited: {
    key: 'unlimited',
    label: 'Unlimited',
    pillClass: 'bg-slate-200 text-fg dark:bg-slate-700',
    dotClass: 'bg-slate-500',
    badgeColor: 'indigo',
    sort: 4,
  },
};

// The selectable/displayed tiers — excludes `unlimited` (billing-off-only, never
// shown as a choice when billing is enabled).
export const TIER_KEYS: readonly TierKey[] = ['developer', 'pro', 'team', 'enterprise'];

export function getTierMeta(tier: string | undefined | null): TierMeta {
  if (tier && tier in TIER_META) return TIER_META[tier as TierKey];
  return TIER_META.developer;
}

/** Every tier, selectable or not — for FILTERS and other read surfaces, which
 *  must be able to name `unlimited` (on a billing-disabled install it is the
 *  tier every organization is on). Purchase pickers use {@link TIER_KEYS}. */
export const ALL_TIER_KEYS: readonly TierKey[] = Object.keys(TIER_META) as TierKey[];

/**
 * Tiers that may parent a team. Mirrors api-core's `TEAM_CAPABLE_TIERS` — the
 * backend's `organizationService.checkParentEligible` is the authority, and
 * `unlimited` (billing off) is the most permissive tier, so leaving it out here
 * hid "Create team" on every billing-disabled deployment.
 */
export const TEAM_CAPABLE_TIERS: readonly TierKey[] = ['team', 'enterprise', 'unlimited'];

/** Whether `tier` may parent a team. */
export function tierAllowsTeams(tier: string | undefined | null): boolean {
  return !!tier && (TEAM_CAPABLE_TIERS as readonly string[]).includes(tier);
}
