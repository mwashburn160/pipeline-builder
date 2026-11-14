// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envBool, envInt, envNameFragment, envStr } from '../utils/env.js';
import type { QuotaType } from './common.js';
import { DEFAULT_TIER_LIMITS, tierLabel, type QuotaTierLimits } from './tier-limits.js';

/**
 * The limits shape, the code-default table and the sizing arithmetic live in
 * `./tier-limits.js` — dependency-free, so the BROWSER imports them
 * (`@pipeline-builder/api-core/tier-limits`) instead of keeping a hand-synced
 * copy — and so do the tier-ladder facts the browser also decides with (which
 * tiers may parent a team or buy a seat pack). Re-exported here because this is
 * the module every server consumer and the package barrel already name; what
 * stays here is everything the env touches.
 */
export {
  AUTOMATION_CALLS_SIZING, automationCallsFor, DEFAULT_TIER_LIMITS, SEAT_PACK_TIERS, seatRemedy, TEAM_CAPABLE_TIERS, tierAllowsTeams, tierLabel,
} from './tier-limits.js';
export type { QuotaTierLimits, SeatRemedy } from './tier-limits.js';

/** Available quota tier identifiers.
 *
 * `unlimited` is a special tier: every quota is `-1` (uncapped) and it includes
 * every feature/add-on bundle. It is the DEFAULT when billing is disabled (no
 * metering/enforcement surface exists, so nothing is capped), and it is NEVER
 * shown or selectable when billing is enabled — see `STANDARD_TIERS`. */
export type QuotaTier = 'developer' | 'pro' | 'team' | 'business' | 'enterprise' | 'unlimited';

/** Full preset for a single tier (label + limits). */
export interface QuotaTierPreset {
  label: string;
  limits: QuotaTierLimits;
}

/**
 * The SOFT band above a quota's cap, per type, in percent of the limit. A type
 * absent from this map has NO band and stops hard at 100%.
 *
 * At 100% the account gets the "reached" notice and keeps running; the refusal
 * starts only past `limit × (100 + pct) / 100`. Reads still REPORT the nominal
 * limit, so usage shows above 100% while inside the band.
 *
 * Two types qualify, for the same reason stated two ways — a hard stop exactly
 * at 100% is worse than a short overrun when the caller cannot simply wait:
 *
 * - `automationCalls` (`QUOTA_AUTOMATION_GRACE_PCT`): the caller is a pipeline
 *   mid-deploy, not a person, and the counter would stay full for the rest of
 *   the period.
 * - `storageBytes` (`QUOTA_STORAGE_GRACE_PCT`): storage is a STOCK — it does
 *   not reset, so without a band a downgrade or a cancelled pack flips an
 *   account from working to refused with no buffer at all, and the remedy
 *   (prune, or buy capacity) takes time the band is there to provide. Note the
 *   band on a stock is a ONE-TIME buffer rather than a per-period one; that is
 *   its purpose here, not a limitation of it.
 *
 * Every other type stays hard. This was a hardcoded `quotaType !==
 * 'automationCalls'` comparison, which is why storage had nothing: the
 * mechanism existed and only the predicate excluded it.
 */
const QUOTA_GRACE_PCT: Readonly<Record<string, number>> = {
  automationCalls: envInt('QUOTA_AUTOMATION_GRACE_PCT', 10, { min: 0, max: 100 }),
  storageBytes: envInt('QUOTA_STORAGE_GRACE_PCT', 10, { min: 0, max: 100 }),
  // `satisfies Partial<…>` keeps BOTH properties this map needs: the keys are
  // checked against `QuotaType` (a typo'd `storagebytes` would otherwise leave a
  // banded quota stopping hard at 100%, silently), while the annotation keeps the
  // string index the accessor below needs for an untrusted `quotaType`. Partial
  // because absence is meaningful here — see above.
} satisfies Partial<Record<QuotaType, number>>;

/** The soft band for `quotaType` in percent, or 0 for a type that stops hard. */
export function quotaGracePct(quotaType: string): number {
  return QUOTA_GRACE_PCT[quotaType] ?? 0;
}

/**
 * The limit enforcement actually binds on for `quotaType`: the nominal limit,
 * plus the type's {@link quotaGracePct} band where it has one. Unlimited (-1)
 * and zero ("none") limits are returned unchanged — a 0 cap is a deliberate
 * refusal, not a budget to overrun.
 *
 * {@link QUOTA_GRACE_PCT} decides WHETHER a type has a band; `gracePct` only
 * sizes it. So an explicit percentage passed for an unbanded type still yields
 * the nominal limit, rather than quietly granting a band the type is not meant
 * to have.
 */
export function enforcedQuotaLimit(quotaType: string, limit: number, gracePct: number = quotaGracePct(quotaType)): number {
  if (limit <= 0 || gracePct <= 0 || quotaGracePct(quotaType) <= 0) return limit;
  return Math.floor((limit * (100 + gracePct)) / 100);
}

/**
 * Read a tier LIMIT env var. `-1` = unlimited; anything below that is nonsense
 * (a `-5` limit would ship a broken finite cap), so it falls back to the code
 * default rather than clamping up to `-1`. The parsing itself is api-core's
 * shared `envInt` — strict about decimals/garbage — not a local re-derivation.
 */
function tierLimitEnv(name: string, fallback: number): number {
  const n = envInt(name, fallback);
  return n < -1 ? fallback : n;
}

/**
 * Per-tier limits, each overridable via `QUOTA_TIER_<TIER>_<LIMIT>` env vars
 * (e.g. `QUOTA_TIER_PRO_PIPELINES=250`, `QUOTA_TIER_DEVELOPER_STORAGE_BYTES=...`).
 * Unset/empty → the code default. `-1` = unlimited. Read once at module load —
 * on k8s these flow in via the `app-env` ConfigMap (built from `.env`).
 */
function tierLimits(tier: QuotaTier): QuotaTierLimits {
  // `unlimited` is uncapped BY DEFINITION: EVERY quota is -1 and it is NOT
  // env-overridable. Reading QUOTA_TIER_UNLIMITED_* here would let a stray env
  // var silently cap the billing-DISABLED default tier — surfacing as a spurious
  // "quota exceeded" on a deploy that meters nothing. Derive -1 for every field
  // from the limits shape so a newly-added quota is uncapped here automatically.
  if (tier === 'unlimited') {
    const uncapped = { ...DEFAULT_TIER_LIMITS.unlimited };
    for (const k of Object.keys(uncapped) as (keyof QuotaTierLimits)[]) uncapped[k] = -1;
    return uncapped;
  }
  const d = DEFAULT_TIER_LIMITS[tier];
  const T = tier.toUpperCase();
  // Keyed off the limits table rather than seventeen hand-written lines, so a
  // newly-added limit is env-overridable the moment it has a default — the hand
  // list made that a second edit, in a file where forgetting it yields a knob
  // the docs describe and the code ignores.
  const out = { ...d };
  for (const field of Object.keys(out) as (keyof QuotaTierLimits)[]) {
    // The knob names are DERIVED from the field names (`envNameFragment`), which
    // is why `test/quota-tiers.test.ts` pins the full set of seventeen: a field
    // rename would otherwise move somebody's configured knob without a word.
    out[field] = tierLimitEnv(`QUOTA_TIER_${T}_${envNameFragment(field)}`, d[field]);
  }
  return out;
}

/** All valid tier names (incl. `unlimited`), in ladder order. Used for validation
 *  of a *stored* tier — `unlimited` is a valid value even though it's never
 *  offered for sale. Derived from the code-default limits table, which is the one
 *  place a tier cannot be added without being given numbers. */
export const VALID_TIERS: readonly QuotaTier[] = Object.keys(DEFAULT_TIER_LIMITS) as QuotaTier[];

/**
 * Every tier's preset, keyed off {@link VALID_TIERS} rather than written out
 * tier by tier — a tier added to the limits table gets its preset here with no
 * second edit.
 *
 * The label defaults to {@link tierLabel} of the key ("business" → "Business",
 * "pro_plus" → "Pro Plus"), which is what all six were spelled as by hand, and
 * stays overridable via `QUOTA_TIER_<TIER>_LABEL` for a deployment that wants its
 * own wording — or for a key the derivation cannot get right, such as an acronym.
 * Display name only: it never affects a limit.
 */
export const QUOTA_TIERS: Record<QuotaTier, QuotaTierPreset> = Object.fromEntries(
  VALID_TIERS.map((tier) => [tier, {
    label: envStr(`QUOTA_TIER_${tier.toUpperCase()}_LABEL`, tierLabel(tier)),
    limits: tierLimits(tier),
  }]),
) as Record<QuotaTier, QuotaTierPreset>;

/** The standard, billing-selectable tiers — the ones offered as purchasable plans
 *  and shown in tier pickers. Derived as "every valid tier except `unlimited`",
 *  which is the billing-DISABLED default and is never displayed/selectable when
 *  billing is enabled. Kept DRY off `VALID_TIERS` so adding a tier flows through. */
export const STANDARD_TIERS: readonly QuotaTier[] = VALID_TIERS.filter((t) => t !== 'unlimited');

/** Whether the billing service is enabled in this deployment (`BILLING_ENABLED`,
 *  opt-out default-on — mirrors the billing/platform configs). With billing OFF
 *  there's no metering/enforcement surface, so the default tier is `unlimited`. */
export function isBillingEnabled(): boolean {
  return envBool('BILLING_ENABLED', true);
}

/**
 * Default tier assigned to new organizations.
 * - Billing DISABLED → `unlimited` (nothing is metered, so everything is uncapped).
 * - Billing ENABLED  → `DEFAULT_QUOTA_TIER` if it's a valid standard tier, else `developer`.
 */
export const DEFAULT_TIER: QuotaTier = !isBillingEnabled()
  ? 'unlimited'
  : (isValidTier(process.env.DEFAULT_QUOTA_TIER ?? '') && process.env.DEFAULT_QUOTA_TIER !== 'unlimited'
    ? (process.env.DEFAULT_QUOTA_TIER as QuotaTier)
    : 'developer');

/** Check whether a string is a valid QuotaTier. */
export function isValidTier(value: string): value is QuotaTier {
  // Use the explicit tuple, not `value in QUOTA_TIERS`: `in` walks the prototype
  // chain, so inherited Object keys ('toString', 'constructor', …) would return
  // true and then `getTierLimits` would read `.limits` off a function → crash.
  // `tier` is attacker-influenceable (JWT / request body / DEFAULT_QUOTA_TIER env).
  return (VALID_TIERS as readonly string[]).includes(value);
}

/** Get the default limits for a given tier (falls back to developer). */
export function getTierLimits(tier: string): QuotaTierLimits {
  return isValidTier(tier) ? QUOTA_TIERS[tier].limits: QUOTA_TIERS.developer.limits;
}

/**
 * The period (days) every usage counter rolls over on. All quotas are per-period
 * FLOW counters on one shared period: the quota service resets a counter this
 * many days after it expires, and platform seeds a new org's counters with the
 * same window (`QUOTA_RESET_DAYS`, default 3).
 */
export const QUOTA_RESET_DAYS = envInt('QUOTA_RESET_DAYS', 3, { min: 1 });

/** The next quota reset: local midnight `days` from `now`. */
/**
 * The `cpuCredits` period, in days. A MONTH rather than the global three-day
 * window, because build demand is bursty in a way API traffic is not: a full
 * catalogue rebuild is a day's work that arrives on one day, and a three-day
 * window refuses it while the account holds most of a month's budget unspent.
 */
export const CPU_CREDITS_PERIOD_DAYS = envInt('QUOTA_CPU_CREDITS_PERIOD_DAYS', 30, { min: 1 });

/**
 * The usage period for ONE quota type, in days.
 *
 * Every flow quota but `cpuCredits` rolls on the global {@link QUOTA_RESET_DAYS}.
 * Credits are monthly, which makes the period a PER-TYPE fact — so anything that
 * computes a reset date, a "resets in N days" line or a burn-rate forecast has
 * to ask for the type's own period rather than reading the global constant. A
 * forecast against the wrong window is wrong by a factor of ten.
 *
 * Stocks (`storageBytes` and the resource counts) have no period at all; this
 * returns the global window for them because callers gate on
 * `quotaAccrual(type) === 'stock'` before using it, and returning a figure is
 * less disruptive than making every caller handle a null. Check the accrual.
 */
export function quotaPeriodDays(type: QuotaType): number {
  return type === 'cpuCredits' ? CPU_CREDITS_PERIOD_DAYS : QUOTA_RESET_DAYS;
}

export function nextQuotaResetDate(days: number = QUOTA_RESET_DAYS, now: Date = new Date()): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date;
}
