// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Available quota tier identifiers. */
export type QuotaTier = 'developer' | 'pro' | 'team' | 'enterprise';

/** Limit values for each quota type within a tier. */
export interface QuotaTierLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
  aiCalls: number;
  /**
   * Aggregate registry storage cap in BYTES. Counted across every repo
   * under the org's `org-{orgId}/` namespace. -1 means unlimited.
   * push-gate reads this; the image-registry rejects token issuance for
   * `push` scope when the org's measured usage exceeds the limit.
   */
  storageBytes: number;
  /** Count-quotas on the user-editable feature tables added to close per-org
   *  DoS via spam. -1 means unlimited. */
  dashboards: number;
  alertRules: number;
  alertDestinations: number;
  idpConfigs: number;
  /**
   * Max org members (active users / seats). -1 = unlimited. This is the "Team"
   * tier differentiator — enforced at member-invite time (an invite is blocked
   * when active members + pending invites would exceed this).
   */
  seats: number;
}

/** Full preset for a single tier (label + limits). */
export interface QuotaTierPreset {
  label: string;
  limits: QuotaTierLimits;
}

/**
 * Preset limits for each tier. -1 means unlimited.
 *
 * AI calls are sized much smaller than `apiCalls` because each call has
 * external provider cost (~$0.01$0.10/call). Developer tier allows light
 * exploration (50/period); Pro lifts to 2,500; Enterprise is capped high
 * (25,000) — fair-use, not literally unlimited.
 *
 * `storageBytes` is the aggregate registry cap per org. Sized
 * around plugin-image realities: a typical plugin image is 200500 MB;
 * Developer's 2 GB holds ~4 versions × ~500 MB, Pro's 50 GB covers a
 * mature catalog. Operators can override per-org via the quota CRUD API.
 */
const GB = 1024 * 1024 * 1024;

/**
 * Code-default limits per tier — the fallback when no env override is set.
 * -1 means unlimited. (Counts sized to "comfortably enough for one team, not
 * script spam": 20 dashboards, 50 alert rules, 10 destinations, 1 IdP config
 * for Developer; scaled up for Pro; -1 (uncapped) for the count-quotas on
 * Team/Enterprise while cost-driving quotas stay finite.)
 */
const TB = 1024 * GB;
const DEFAULT_TIER_LIMITS: Record<QuotaTier, QuotaTierLimits> = {
  // Free tier: single seat, apiCalls CAPPED (was unlimited — a DoS/abuse hole
  // on a shared resource); aiCalls small (each has ~$0.01-0.10 external cost).
  developer: {
    plugins: 25,
    pipelines: 5,
    apiCalls: 25_000,
    aiCalls: 50,
    storageBytes: 2 * GB,
    dashboards: 20,
    alertRules: 50,
    alertDestinations: 10,
    idpConfigs: 1,
    seats: 1,
  },
  // Pro = one power user, individual pricing.
  pro: {
    plugins: 50,
    pipelines: 10,
    apiCalls: 500_000,
    aiCalls: 2_500,
    storageBytes: 50 * GB,
    dashboards: 200,
    alertRules: 500,
    alertDestinations: 50,
    idpConfigs: 5,
    seats: 1,
  },
  // Team = collaboration tier; the seat limit (10) is the real differentiator
  // over Pro. Limits sit between Pro and Enterprise.
  team: {
    plugins: 100,
    pipelines: 200,
    apiCalls: -1,
    aiCalls: 10_000,
    storageBytes: 250 * GB,
    dashboards: -1,
    alertRules: -1,
    alertDestinations: -1,
    idpConfigs: 5,
    seats: 10,
  },
  // Enterprise: org-wide, high seat cap. FAIR-USE — cost drivers (aiCalls,
  // storageBytes) capped high so one account can't run up unbounded provider/
  // storage cost on a flat price; cheap count-quotas stay -1.
  enterprise: {
    plugins: 250,
    pipelines: 200,
    apiCalls: -1,
    aiCalls: 25_000,
    storageBytes: TB,
    dashboards: -1,
    alertRules: -1,
    alertDestinations: -1,
    idpConfigs: -1,
    seats: 25,
  },
};

/** Read an integer env var, falling back to the code default. `-1` = unlimited. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Read a string env var, falling back to the code default. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * Per-tier limits, each overridable via `QUOTA_TIER_<TIER>_<LIMIT>` env vars
 * (e.g. `QUOTA_TIER_PRO_PIPELINES=250`, `QUOTA_TIER_DEVELOPER_STORAGE_BYTES=...`).
 * Unset/empty → the code default. `-1` = unlimited. Read once at module load —
 * on k8s these flow in via the `app-env` ConfigMap (built from `.env`).
 */
function tierLimits(tier: QuotaTier): QuotaTierLimits {
  const d = DEFAULT_TIER_LIMITS[tier];
  const T = tier.toUpperCase();
  return {
    plugins: envInt(`QUOTA_TIER_${T}_PLUGINS`, d.plugins),
    pipelines: envInt(`QUOTA_TIER_${T}_PIPELINES`, d.pipelines),
    apiCalls: envInt(`QUOTA_TIER_${T}_API_CALLS`, d.apiCalls),
    aiCalls: envInt(`QUOTA_TIER_${T}_AI_CALLS`, d.aiCalls),
    storageBytes: envInt(`QUOTA_TIER_${T}_STORAGE_BYTES`, d.storageBytes),
    dashboards: envInt(`QUOTA_TIER_${T}_DASHBOARDS`, d.dashboards),
    alertRules: envInt(`QUOTA_TIER_${T}_ALERT_RULES`, d.alertRules),
    alertDestinations: envInt(`QUOTA_TIER_${T}_ALERT_DESTINATIONS`, d.alertDestinations),
    idpConfigs: envInt(`QUOTA_TIER_${T}_IDP_CONFIGS`, d.idpConfigs),
    seats: envInt(`QUOTA_TIER_${T}_SEATS`, d.seats),
  };
}

// Labels are overridable via `QUOTA_TIER_<TIER>_LABEL` (display name only).
export const QUOTA_TIERS: Record<QuotaTier, QuotaTierPreset> = {
  developer: { label: envStr('QUOTA_TIER_DEVELOPER_LABEL', 'Developer'), limits: tierLimits('developer') },
  pro: { label: envStr('QUOTA_TIER_PRO_LABEL', 'Pro'), limits: tierLimits('pro') },
  team: { label: envStr('QUOTA_TIER_TEAM_LABEL', 'Team'), limits: tierLimits('team') },
  enterprise: { label: envStr('QUOTA_TIER_ENTERPRISE_LABEL', 'Enterprise'), limits: tierLimits('enterprise') },
};

/** All valid tier names. */
export const VALID_TIERS: readonly QuotaTier[] = Object.keys(QUOTA_TIERS) as QuotaTier[];

/**
 * Default tier assigned to new organizations. Overridable via the
 * `DEFAULT_QUOTA_TIER` env var (one of developer|pro|team|enterprise);
 * an invalid/unset value falls back to 'developer'.
 */
export const DEFAULT_TIER: QuotaTier =
  isValidTier(process.env.DEFAULT_QUOTA_TIER ?? '')
    ? (process.env.DEFAULT_QUOTA_TIER as QuotaTier)
    : 'developer';

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
