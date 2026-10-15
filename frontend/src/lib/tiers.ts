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
 *  which is how `unlimited` kept getting dropped from tier unions around the
 *  app. It is the default when billing is off AND the platform system org's
 *  tier when billing is on, so no surface can treat it as unreachable. */
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
  // Everything uncapped, and never sold. It is the default tier when billing is
  // DISABLED, and with billing enabled it is the tier the platform's own system
  // org runs on — so "billing is on" is not a reason to assume no org is here.
  // Meta exists so such an org renders correctly, but it's intentionally NOT in
  // TIER_KEYS: it is never offered as a purchasable tier.
  unlimited: {
    key: 'unlimited',
    label: 'Unlimited',
    pillClass: 'bg-slate-200 text-fg dark:bg-slate-700',
    dotClass: 'bg-slate-500',
    badgeColor: 'indigo',
    sort: 4,
  },
};

// The selectable/displayed tiers — excludes `unlimited`, which is never sold.
// A surface that must NAME the tier an org is actually on wants ALL_TIER_KEYS;
// this list is for pickers, which must not offer it.
export const TIER_KEYS: readonly TierKey[] = ['developer', 'pro', 'team', 'enterprise'];

export function getTierMeta(tier: string | undefined | null): TierMeta {
  if (tier && tier in TIER_META) return TIER_META[tier as TierKey];
  return TIER_META.developer;
}

/** Every tier, selectable or not — for FILTERS, RANKING and other read surfaces,
 *  which must be able to name `unlimited` (every org on a billing-disabled
 *  install, and the system org always). Purchase pickers use {@link TIER_KEYS}. */
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

/**
 * Tiers that may buy extra seats (billing's per-seat add-on). Mirrors api-core's
 * `SEAT_PACK_TIERS`, which the billing catalog itself uses — test/seat-remedy
 * holds the two equal. Developer and Pro are single-seat tiers: their way to
 * more seats is an upgrade, so offering them a seat pack sent them to an add-on
 * billing would not sell them.
 */
export const SEAT_PACK_TIERS: readonly TierKey[] = ['team', 'enterprise'];

/** How an account that has used every seat can get another. */
export type SeatRemedy = 'upgrade' | 'seat_pack';

/** The remedy for the ACCOUNT's tier; `null` for an uncapped or unknown tier. Mirrors api-core's `seatRemedy`. */
export function seatRemedy(tier: string | undefined | null): SeatRemedy | null {
  if (!tier || !(ALL_TIER_KEYS as readonly string[]).includes(tier) || tier === 'unlimited') return null;
  return (SEAT_PACK_TIERS as readonly string[]).includes(tier) ? 'seat_pack' : 'upgrade';
}

/** Pooled seat usage as `GET /organization/:id/seat-usage` reports it (root account). */
export interface SeatUsage {
  limit: number;
  used: number;
  /** The account's (root) tier — what decides {@link seatRemedy}. */
  tier?: string;
}

/** Every seat is taken (members + live pending invites); `false` when unlimited or unknown. */
export function seatsAtCapacity(usage: SeatUsage | null | undefined): boolean {
  return !!usage && usage.limit !== -1 && usage.used >= usage.limit;
}

/** The action that frees capacity, in the caller's words: "upgrade to Team" / "add a seat pack". */
export function seatRemedyLabel(remedy: SeatRemedy | null): string | null {
  return remedy === 'upgrade' ? 'upgrade to Team' : remedy === 'seat_pack' ? 'add a seat pack' : null;
}
