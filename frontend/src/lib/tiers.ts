// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the four quota tiers' display metadata
 * (label, color classes, sort order). Consolidates copies that lived in
 * dashboard/quotas.tsx, dashboard/billing.tsx, and admin/orgs/[orgId].tsx.
 * Adding a new tier here updates every UI surface in one place.
 */
export type TierKey = 'developer' | 'pro' | 'team' | 'enterprise';

export interface TierMeta {
  /** Lowercase enum key as stored by the quota service. */
  readonly key: TierKey;
  /** Human-readable label (Title Case). */
  readonly label: string;
  /** Tailwind classes for a coloured pill (background + text). */
  readonly pillClass: string;
  /** Tailwind classes for a coloured dot. */
  readonly dotClass: string;
  /** Stable display order: developer < pro < team < enterprise. */
  readonly sort: number;
}

export const TIER_META: Record<TierKey, TierMeta> = {
  developer: {
    key: 'developer',
    label: 'Developer',
    pillClass: 'bg-blue-100 text-blue-800',
    dotClass: 'bg-blue-500',
    sort: 0,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    pillClass: 'bg-purple-100 text-purple-800',
    dotClass: 'bg-purple-500',
    sort: 1,
  },
  team: {
    key: 'team',
    label: 'Team',
    pillClass: 'bg-emerald-100 text-emerald-800',
    dotClass: 'bg-emerald-500',
    sort: 2,
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    pillClass: 'bg-amber-100 text-amber-800',
    dotClass: 'bg-amber-500',
    sort: 3,
  },
};

export const TIER_KEYS: readonly TierKey[] = ['developer', 'pro', 'team', 'enterprise'];

export function getTierMeta(tier: string | undefined | null): TierMeta {
  if (tier && tier in TIER_META) return TIER_META[tier as TierKey];
  return TIER_META.developer;
}
