// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the quota tiers' display metadata (label,
 * colour classes, sort order) — the pills, badges and the plan cards' accents
 * all read it, so a tier is coloured the same everywhere. Adding a tier here
 * updates every UI surface in one place.
 */
import type { BadgeColor } from '@/components/ui/Badge';
import type { QuotaTier } from '@pipeline-builder/api-core';
import type { SeatRemedy } from '@pipeline-builder/api-core/tier-limits';

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
  /** A plan card's accent: border + tinted background, the same hue as the pill.
   *  (PlanGrid kept its own map, which coloured three tiers differently from
   *  their pills and had no entry for `business`.) */
  readonly accent: { readonly border: string; readonly bg: string };
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
    accent: { border: 'border-blue-500', bg: 'bg-info-bg' },
    sort: 0,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    pillClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    dotClass: 'bg-purple-500',
    badgeColor: 'purple',
    accent: { border: 'border-purple-500', bg: 'bg-purple-50 dark:bg-purple-950' },
    sort: 1,
  },
  team: {
    key: 'team',
    label: 'Team',
    pillClass: 'bg-success-bg text-success-strong',
    dotClass: 'bg-emerald-500',
    badgeColor: 'green',
    accent: { border: 'border-emerald-500', bg: 'bg-success-bg' },
    sort: 2,
  },
  business: {
    key: 'business',
    label: 'Business',
    // Its own colour, not Team's: these were byte-identical at first, which made
    // a Business pill visually indistinguishable from a Team pill on every
    // surface that renders one. `green` is Team's, `blue`/`gray` developer's,
    // `purple` Pro's, `red` Enterprise's and `indigo` unlimited's — cyan with a
    // `blue` badge is the one combination left that reads as distinct.
    pillClass: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
    dotClass: 'bg-cyan-500',
    badgeColor: 'blue',
    accent: { border: 'border-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950' },
    sort: 3,
  },
  enterprise: {
    key: 'enterprise',
    label: 'Enterprise',
    pillClass: 'bg-warning-bg text-warning-strong',
    dotClass: 'bg-amber-500',
    badgeColor: 'red',
    accent: { border: 'border-amber-500', bg: 'bg-warning-bg' },
    sort: 4,
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
    accent: { border: 'border-slate-500', bg: 'bg-surface-muted' },
    sort: 5,
  },
};

// The selectable/displayed tiers — excludes `unlimited`, which is never sold.
// A surface that must NAME the tier an org is actually on wants ALL_TIER_KEYS;
// this list is for pickers, which must not offer it.
export const TIER_KEYS: readonly TierKey[] = ['developer', 'pro', 'team', 'business', 'enterprise'];

export function getTierMeta(tier: string | undefined | null): TierMeta {
  if (tier && tier in TIER_META) return TIER_META[tier as TierKey];
  return TIER_META.developer;
}

/** Every tier, selectable or not — for FILTERS, RANKING and other read surfaces,
 *  which must be able to name `unlimited` (every org on a billing-disabled
 *  install, and the system org always). Purchase pickers use {@link TIER_KEYS}. */
export const ALL_TIER_KEYS: readonly TierKey[] = Object.keys(TIER_META) as TierKey[];

// Which tiers may parent a team or buy a seat pack (`TEAM_CAPABLE_TIERS`,
// `tierAllowsTeams`, `SEAT_PACK_TIERS`, `seatRemedy`) is api-core's own decision,
// imported by callers from its browser-safe `tier-limits` subpath — the backend
// (`checkParentEligible`, the billing catalog) decides with the same functions.

/** Pooled seat usage as `GET /organization/:id/seat-usage` reports it (root account). Not
 *  billing's `SeatUsage` (types/billing.ts) — that is the billing rollup's shape. */
export interface AccountSeatUsage {
  limit: number;
  used: number;
  /** The account's (root) tier — what decides {@link seatRemedy}. */
  tier?: string;
}

/** Every seat is taken (members + live pending invites); `false` when unlimited or unknown. */
export function seatsAtCapacity(usage: AccountSeatUsage | null | undefined): boolean {
  return !!usage && usage.limit !== -1 && usage.used >= usage.limit;
}

/** The action that frees capacity, in the caller's words: "upgrade to Team" / "add a seat pack". */
export function seatRemedyLabel(remedy: SeatRemedy | null): string | null {
  return remedy === 'upgrade' ? 'upgrade to Team' : remedy === 'seat_pack' ? 'add a seat pack' : null;
}
