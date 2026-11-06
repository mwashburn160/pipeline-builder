// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { quotaLabelPlural } from '@pipeline-builder/api-core/quota-catalog';
import { DEFAULT_TIER_LIMITS } from '@pipeline-builder/api-core/tier-limits';
import { ALL_TIER_KEYS, TIER_META, TIER_KEYS as SHARED_TIER_KEYS } from '@/lib/tiers';
import type { QuotaTier, DisplayedQuotaType } from '@/types';
import { DISPLAYED_QUOTA_TYPES } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QUOTA_KEYS: readonly DisplayedQuotaType[] = DISPLAYED_QUOTA_TYPES;

/**
 * Cut-offs the at-risk views offer, in percent. 100 means "already exhausted" —
 * the quota service treats `threshold=100` as exactly that. Shared so the
 * sysadmin banner and an owner's own callout offer the same steps.
 */
export const AT_RISK_THRESHOLDS = [50, 70, 80, 90, 100] as const;

export const TIER_KEYS: QuotaTier[] = [...SHARED_TIER_KEYS];

// Descriptions stay local — they're page-specific copy for the preset editor and
// not appropriate for the shared TIER_META catalog, which every tier pill in the
// app reads. Label and dot color DO come from TIER_META so renames stay in one
// place, and the numbers come from api-core.
const TIER_DESCRIPTIONS: Record<QuotaTier, string> = {
  developer: 'Starter tier',
  pro: 'Production use',
  team: 'Team collaboration',
  business: 'Scaling organizations',
  enterprise: 'Highest limits',
  // Billing-off default — never shown as a preset (excluded from TIER_KEYS).
  unlimited: 'Everything uncapped',
};

/**
 * The per-tier limits the quota-admin editor prefills its presets from, as a
 * projection of api-core's REAL defaults onto the seven quota types this UI
 * renders — not a copy of them.
 *
 * It used to be a hand-written table under a "keep in sync" comment, held
 * against api-core by a test that parsed both files' source text. Nothing
 * reported drift at runtime: the server's effective limits are overlaid on top
 * (see {@link buildTierPresets}), so a stale number only showed up as a preset
 * an admin clicked and SAVED onto a real org. The limits table is now
 * dependency-free and browser-importable, so the copy is gone and the drift is
 * no longer expressible.
 *
 * These are the CODE defaults, which is the right fallback: the env-overlaid
 * figures (`QUOTA_TIER_*`) are per-deployment and arrive from `/config`.
 *
 * Developer's 20 aiCalls are a TRIAL allowance: the tier holds `ai_generation`
 * so generation is usable, and the UI labels the allowance as a trial
 * (`isAITrialTier`) with an upgrade CTA once it runs out.
 */
const TIER_LIMITS: Record<QuotaTier, Record<DisplayedQuotaType, number>> = Object.fromEntries(
  ALL_TIER_KEYS.map((tier) => [
    tier,
    Object.fromEntries(QUOTA_KEYS.map((key) => [key, DEFAULT_TIER_LIMITS[tier][key]])),
  ]),
) as Record<QuotaTier, Record<DisplayedQuotaType, number>>;

export type TierPreset = { label: string; description: string; color: string; limits: Record<DisplayedQuotaType, number> };

/**
 * Build the per-tier presets from a limits table (label/description/color stay
 * local; only the numeric limits vary by deployment). {@link buildTierPresets}
 * uses this to overlay server-provided limits onto the hardcoded fallback.
 */
function presetsFromLimits(limits: Record<QuotaTier, Record<DisplayedQuotaType, number>>): Record<QuotaTier, TierPreset> {
  return Object.fromEntries(
    ALL_TIER_KEYS.map((tier) => [tier, {
      label: TIER_META[tier].label,
      description: TIER_DESCRIPTIONS[tier],
      color: TIER_META[tier].dotClass,
      limits: limits[tier],
    }]),
  ) as Record<QuotaTier, TierPreset>;
}

/**
 * The hardcoded fallback presets — used until (and if) the server's effective
 * presets load. Sourced from the local `TIER_LIMITS` mirror of the backend
 * defaults.
 */
export const TIER_PRESETS: Record<QuotaTier, TierPreset> = presetsFromLimits(TIER_LIMITS);

/**
 * Merge server-provided effective tier limits (from `/config`'s `tierPresets`,
 * which honors `QUOTA_TIER_*` env overrides) over the hardcoded fallback, and
 * return the full presets. Fail-soft: any tier/field the server omits keeps its
 * hardcoded value, and passing `undefined` (config not loaded / fetch failed)
 * returns the fallback unchanged. This is the drift fix for pkg#9 — the editor
 * prefills from the deployment's REAL limits, not a frontend copy that silently
 * diverges under env overrides.
 */
export function buildTierPresets(
  serverPresets?: Partial<Record<QuotaTier, Partial<Record<DisplayedQuotaType, number>>>>,
): Record<QuotaTier, TierPreset> {
  if (!serverPresets) return TIER_PRESETS;
  const merged = {} as Record<QuotaTier, Record<DisplayedQuotaType, number>>;
  for (const tier of ALL_TIER_KEYS) {
    merged[tier] = { ...TIER_LIMITS[tier] };
    const fromServer = serverPresets[tier];
    if (fromServer) {
      for (const key of QUOTA_KEYS) {
        const v = fromServer[key];
        if (typeof v === 'number' && Number.isFinite(v)) merged[tier][key] = v;
      }
    }
  }
  return presetsFromLimits(merged);
}

// ---------------------------------------------------------------------------
// Pooling copy
// ---------------------------------------------------------------------------

/**
 * ONE wording for pooled limits, used everywhere the subject comes up.
 *
 * It was said four different ways — "Pooled at <uuid>", "Pooled across your
 * organization", "Pooled across the parent organization", "(pooled across your
 * organization)" — none of which explained what pooling DOES, and one of which
 * named an org by raw id. The two questions a reader actually has are "whose
 * limit binds me?" and "what happens to the seats I am about to buy?", so the
 * answer to both lives in the copy itself rather than in a tooltip.
 *
 * `rootName` is the pool root's display NAME; callers pass `undefined` when the
 * API could not resolve one and the copy stays generic rather than printing an
 * id at the reader.
 */
export const POOLING_TITLE = 'Shared across your whole organization';

/**
 * The explanation, from the point of view of `perspective`:
 *  - `team` — the viewer is in a team and is bound by the root's caps;
 *  - `root` — the viewer IS the root and its caps bind every team below it.
 */
export function poolingExplanation(
  perspective: 'team' | 'root',
  rootName?: string,
  teamCount?: number,
): string {
  const root = rootName || 'the root organization';
  const teams = typeof teamCount === 'number' && teamCount > 0
    ? ` and its ${teamCount} team${teamCount === 1 ? '' : 's'}`
    : ' and its teams';
  return perspective === 'team'
    ? `Limits and seats are not per-team. ${root}${teams} draw from ONE set of caps, set on ${root} — that is the limit that binds you here, and the usage shown is everyone's combined total. A seat or add-on bought on ${root} can be used by any team, including this one.`
    : `Limits and seats are not per-team. This organization${teams} draw from ONE set of caps, set here — these are the limits that bind all of them, and the usage shown is everyone's combined total. A seat or add-on bought here can be used by any team.`;
}
