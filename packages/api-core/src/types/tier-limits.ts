// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a tier GIVES you, as DATA ONLY — the limits shape, the code-default
 * number for every tier x quota type, and the arithmetic those numbers were
 * derived from.
 *
 * Dependency-free and env-free so the browser imports it directly
 * (`@pipeline-builder/api-core/tier-limits`). Its only import is a type, which
 * is erased at compile time, so nothing of the server graph reaches the bundle.
 * The env OVERLAY (`QUOTA_TIER_<TIER>_<LIMIT>`) deliberately stays in
 * `quota-tiers.ts`: it reads `process.env`, which is what kept this table out of
 * the browser's reach in the first place.
 *
 * WHY IT EXISTS. The frontend kept a hand-written copy of this table
 * (`frontend/src/components/quotas/constants.ts`, under a "keep in sync"
 * comment) because importing the real one meant importing a module with sixteen
 * env reads. The copy prefills the quota-admin editor's per-tier presets, so a
 * drifted copy did not break the page — an admin clicked a preset and SAVED
 * numbers that were no longer the product's, with nothing anywhere reporting it.
 * A test parsed BOTH files' source text to hold them equal, which is the shape
 * you reach for when the values cannot be shared. Now they can be: the frontend
 * imports this table, the copy is gone, and the drift it guarded is not
 * expressible.
 */

import type { QuotaTier } from './quota-tiers.js';

/**
 * A tier key as product copy: `developer` → "Developer", `pro_plus` → "Pro Plus".
 *
 * Lives here, with the other tier facts, because three callers want it: the
 * default `QUOTA_TIERS` label, the shared test fixture's labels (which kept a
 * second `titleCase` of its own), and the browser.
 *
 * It will NOT guess at an acronym (`sso` → "Sso") or a stylized name ("Pro+"),
 * and deliberately takes no formatting options: the cases it cannot derive need
 * a human writing copy, which is what `QUOTA_TIER_<TIER>_LABEL` is for. A mode
 * flag would add surface without reaching any of them, and a mid-sentence phrase
 * ("… — new version") is a different FACT from a standalone label rather than
 * another style of one — `quota-catalog.ts` carries `label` and `labelPlural` as
 * separate named fields for exactly that reason.
 */
export function tierLabel(tier: string): string {
  return tier
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Limit values for each quota type within a tier. */
export interface QuotaTierLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
  /**
   * Metered API calls made by ORG SERVICE ACCOUNTS (automation), counted
   * instead of `apiCalls` so pipelines can't starve the org's people. See
   * {@link AUTOMATION_CALLS_SIZING} for how the defaults are derived.
   */
  automationCalls: number;
  aiCalls: number;
  /**
   * Aggregate registry storage cap in BYTES. Counted across every repo
   * under the org's `org-{orgId}/` namespace. -1 means unlimited.
   * push-gate reads this; the image-registry rejects token issuance for
   * `push` scope when the org's measured usage exceeds the limit.
   */
  storageBytes: number;
  /**
   * vCPU-MINUTES of plugin-build compute per MONTH — the one quota on a period
   * of its own (every other flow quota rolls on `QUOTA_RESET_DAYS`, 3 days).
   *
   * Derived from the `plugins` cap rather than guessed: `plugins x 10` builds a
   * month, at a flat 30 wall-minutes a build and 1.5 vCPU of buildkitd, so
   * `credits = builds x 45`. The flat per-build figure is deliberate — scaling
   * BOTH the build count and the per-build cost by tier made credits
   * superlinear in tier on the strength of an unmeasured claim, and it made a
   * pack's credit grant tier-dependent, which the catalogue's grant shape cannot
   * express.
   *
   * This is the first dimension with genuine per-unit marginal cost: every other
   * quota is a rate limit protecting shared infrastructure, this one is compute
   * the platform pays for. See `docs/plans/cpu-credits.md`.
   */
  cpuCredits: number;
  /** Count-quotas on the user-editable feature tables added to close per-org
   *  DoS via spam. -1 means unlimited. */
  dashboards: number;
  alertRules: number;
  alertDestinations: number;
  idpConfigs: number;
  /**
   * Active, non-suspended plugin-ecosystem listings the org publishes
   * (docs/plugin-installing.md). A COUNT quota — installs never
   * count. -1 = unlimited. Extendable via the `listing_pack` add-on bundle.
   */
  listings: number;
  /**
   * Max org members (active users / seats). -1 = unlimited. This is the "Team"
   * tier differentiator — enforced at member-invite time (an invite is blocked
   * when active members + pending invites would exceed this).
   */
  seats: number;
  /**
   * Max designated SUPPORT CONTACTS — the members authorised to open support
   * cases. -1 = unlimited. Base is **0 on every tier**: support is an add-on at
   * every tier and included in none, so an org with no support bundle has no
   * contacts and cannot open a case. That makes the support paywall a quota
   * check rather than a feature flag.
   *
   * Like `seats` this is a tier LIMIT, not a tracked counter — enforced live at
   * designation time against current designations across the org subtree.
   * Extended per unit by the `support_standard` / `support_priority` BASELINE
   * bundles, which are priced per contact.
   */
  supportContacts: number;
  /**
   * How many of those contacts may be UPGRADED to premium (24×7, 8-hour
   * response, and the only ones who may declare `urgent`).
   *
   * A second dimension rather than a third baseline level, because premium is an
   * UPGRADE and not an alternative. The shape it encodes: an org buys N baseline
   * contacts and upgrades M of them, M ≤ N. That is what lets a 100-seat
   * customer give business-hours support to its three named contacts and 24×7
   * to the one who carries the pager — the case the mutually-exclusive ladder
   * could not express at all, where buying "99 standard + 1 premium" charged for
   * 100 units and granted one contact.
   *
   * ADDITIVE, deliberately. A premium contact costs the baseline unit PLUS the
   * upgrade ($19.99 + $99.99), because it is served during business hours
   * through the baseline and overnight through the upgrade; pricing the upgrade
   * as a delta would pretend the baseline were free. Base 0 on every tier, like
   * `supportContacts`, so the paywall stays a quota check.
   */
  supportPremiumContacts: number;
  /**
   * Reporting retention in DAYS — NOT a flow quota (never decremented, absent
   * from `VALID_QUOTA_TYPES`): these ride the tier-baseline + bundle-grant math
   * purely as an entitlement the billing service syncs to reporting's
   * `dora_settings`. -1 = unlimited (the sweep skips the org entirely).
   *   `eventRetentionDays` — non-deploy `pipeline_events` (STAGE/ACTION/build).
   *   `doraRetentionDays`  — deploy events + `deployment_outcomes` + `incidents`,
   *                          and the per-org report-query window for DORA routes.
   * Extendable via the `retention_pack` / `dora_history_pack` add-on bundles.
   */
  eventRetentionDays: number;
  doraRetentionDays: number;
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
 * Developer's 2 GB holds ~4 versions × ~500 MB, Pro's 25 GB covers a
 * mature catalog. Operators can override per-org via the quota CRUD API.
 */
const GB = 1024 * 1024 * 1024;

/**
 * How the `automationCalls` defaults are sized — written down so the next
 * person to touch them argues with the arithmetic, not with the numbers.
 *
 * Every call an org's automation keys make in one pipeline RUN, itemized (the
 * earlier sizing counted only the plugin lookups and hand-waved the rest as
 * "×2"):
 *
 *   plugin lookups            12   one per plugin step (self-mutating pipeline)
 *   synth                      1   the synth step fetching the pipeline config
 *   runtime check              1   the pre-deploy runtime-check call
 *   security-report upload     1   the scan step posting its report
 *   registry register          1   pipeline-register stamping the deployed version
 *   reporting ingest batches  12   the event forwarder posts ~one batch per action
 *                             --
 *                             28   calls per run
 *
 * Per default period (`QUOTA_RESET_DAYS`, 3 days) one active pipeline running
 * hourly makes 28 × 24 × 3 = 2,016 calls. An org keeps far more pipelines alive
 * than it CREATES in a period (`pipelines` is a creation rate), so active
 * pipelines are taken as 4× the tier's `pipelines`. On top sits a per-ORG
 * constant that does not scale with pipelines: the ingest-health heartbeat
 * (≤ 1/minute → 1,440/day → 4,320/period). The sum gets 25% headroom (retries,
 * registry pushes, ad-hoc CI scripts on keys) and rounds UP to the next 10,000:
 *
 *   developer   2×4×2016 + 4320 =  20,448 × 1.25 =  25,560 →  30,000
 *   pro         5×4×2016 + 4320 =  44,640 × 1.25 =  55,800 →  60,000
 *   team       10×4×2016 + 4320 =  84,960 × 1.25 = 106,200 → 110,000
 *   business   20×4×2016 + 4320 = 165,600 × 1.25 = 207,000 → 210,000
 *   enterprise 30×4×2016 + 4320 = 246,240 × 1.25 = 307,800 → 310,000
 *
 * {@link automationCallsFor} computes exactly this, and the tier tests hold the
 * table to it. Over the cap the 429 is SOFT for a band ({@link quotaGracePct}):
 * a self-mutating pipeline that hard-stopped at 100% stayed stopped until the
 * period reset, up to 3 days. The limits are PER PERIOD: an operator who
 * lengthens `QUOTA_RESET_DAYS` should scale `QUOTA_TIER_<TIER>_AUTOMATION_CALLS`
 * by the same factor.
 */
export const AUTOMATION_CALLS_SIZING = {
  callsPerRun: {
    pluginLookups: 12,
    synth: 1,
    runtimeCheck: 1,
    securityReportUpload: 1,
    registryRegister: 1,
    ingestBatches: 12,
  },
  runsPerDay: 24,
  activePipelinesPerCreation: 4,
  /** Ingest-health heartbeats per org per day (≤ one a minute). */
  heartbeatsPerDay: 1440,
  /** Multiplier on the itemized total. */
  headroom: 1.25,
  /** Defaults round UP to a multiple of this. */
  roundTo: 10_000,
} as const;

/** The {@link AUTOMATION_CALLS_SIZING} formula for a tier creating `pipelines` per period. */
export function automationCallsFor(pipelines: number, periodDays: number = 3): number {
  const s = AUTOMATION_CALLS_SIZING;
  const perRun = Object.values(s.callsPerRun).reduce((a, b) => a + b, 0);
  const perPipeline = perRun * s.runsPerDay * periodDays;
  const total = (pipelines * s.activePipelinesPerCreation * perPipeline + s.heartbeatsPerDay * periodDays) * s.headroom;
  return Math.ceil(total / s.roundTo) * s.roundTo;
}

/**
 * Code-default limits per tier — the fallback when no env override is set.
 *
 * SERVER CODE WANTS `getTierLimits(tier)` / `QUOTA_TIERS[tier].limits`, not this
 * table: those carry the deployment's `QUOTA_TIER_*` overrides, and this is what
 * they fall back to. It is exported for the BROWSER, which has no env to overlay
 * and gets the deployment's effective figures from `/config` instead.
 * -1 means unlimited. (Counts sized to "comfortably enough for one team, not
 * script spam": 20 dashboards, 50 alert rules, 10 destinations, 1 IdP config
 * for Developer; scaled up for Pro; -1 (uncapped) for the cheap count-quotas
 * on Team/Enterprise while cost-driving quotas — incl. apiCalls — stay finite.)
 */
export const DEFAULT_TIER_LIMITS: Record<QuotaTier, QuotaTierLimits> = {
  // Free tier: single seat, 2 pipelines, apiCalls CAPPED (was unlimited — a
  // DoS/abuse hole on a shared resource); aiCalls small (each has ~$0.01-0.10
  // external cost). Lean base — growth happens by upgrading, not stacking here.
  developer: {
    plugins: 10,
    pipelines: 2,
    apiCalls: 25_000,
    automationCalls: 30_000,
    aiCalls: 20,
    cpuCredits: 4_500,
    storageBytes: 2 * GB,
    dashboards: 20,
    alertRules: 50,
    alertDestinations: 10,
    idpConfigs: 1,
    listings: 3,
    seats: 1,
    supportContacts: 0,
    supportPremiumContacts: 0,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
  },
  // Pro = individual power user, single seat, individual pricing. A 2nd seat (or
  // team collaboration) requires the Team tier — the `seat` add-on is Team+ only,
  // keeping Team the collaboration tier. Pro's value over Developer is its richer
  // call/storage/plugin ceilings + feature add-ons (SSO/audit/DORA), not seats.
  pro: {
    plugins: 25,
    pipelines: 5,
    apiCalls: 100_000,
    automationCalls: 60_000,
    aiCalls: 200,
    cpuCredits: 11_250,
    storageBytes: 25 * GB,
    dashboards: 200,
    alertRules: 500,
    alertDestinations: 50,
    idpConfigs: 5,
    listings: 10,
    seats: 1,
    supportContacts: 0,
    supportPremiumContacts: 0,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
  },
  // Team = collaboration tier; the seat limit (3) is the real differentiator over
  // Pro (single-seat) — it's the multi-seat collaboration floor. Lean base ($79):
  // growth rides the seat/pipeline/etc add-ons (land-and-expand). Limits sit
  // between Pro and Enterprise.
  team: {
    plugins: 50,
    pipelines: 10,
    apiCalls: 300_000,
    automationCalls: 110_000,
    aiCalls: 600,
    cpuCredits: 22_500,
    storageBytes: 60 * GB,
    dashboards: -1,
    alertRules: -1,
    alertDestinations: -1,
    idpConfigs: 5,
    listings: 25,
    seats: 3,
    supportContacts: 0,
    supportPremiumContacts: 0,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
  },
  // Business ($249): the step the $79 -> $599 cliff was missing. 8 seats, 20
  // pipelines, and DORA (advanced_reporting) included rather than an add-on.
  // Every cost driver is 100,000 apiCalls and 200 aiCalls PER SEAT, the same
  // per-seat rate as Pro/Team/Enterprise, so the ladder reads consistently to a
  // buyer who divides by headcount. Count-quotas that Team already uncaps stay
  // -1; `idpConfigs` sits between Team's 5 and Enterprise's unlimited.
  business: {
    plugins: 100,
    pipelines: 20,
    apiCalls: 800_000,
    automationCalls: 210_000,
    aiCalls: 1_600,
    cpuCredits: 45_000,
    storageBytes: 120 * GB,
    dashboards: -1,
    alertRules: -1,
    alertDestinations: -1,
    idpConfigs: 10,
    listings: 50,
    seats: 8,
    supportContacts: 0,
    supportPremiumContacts: 0,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
  },
  // Enterprise ($599, held): the all-inclusive tier — 15 seats, 30 pipelines, ALL
  // premium features included (see TIER_FEATURES). FAIR-USE — cost drivers (apiCalls,
  // aiCalls, storageBytes) capped so one account can't run up unbounded
  // compute/provider/storage cost on a flat price; cheap count-quotas stay -1.
  enterprise: {
    plugins: 150,
    pipelines: 30,
    apiCalls: 1_500_000,
    automationCalls: 310_000,
    aiCalls: 3_000,
    cpuCredits: 67_500,
    storageBytes: 250 * GB,
    dashboards: -1,
    alertRules: -1,
    alertDestinations: -1,
    idpConfigs: -1,
    listings: 100,
    seats: 15,
    supportContacts: 0,
    supportPremiumContacts: 0,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
  },
  // Unlimited: EVERY quota uncapped (-1). The default when billing is disabled
  // (no enforcement surface) — never shown/selectable when billing is enabled.
  unlimited: {
    plugins: -1,
    pipelines: -1,
    apiCalls: -1,
    automationCalls: -1,
    aiCalls: -1,
    cpuCredits: -1,
    storageBytes: -1,
    dashboards: -1,
    alertRules: -1,
    alertDestinations: -1,
    idpConfigs: -1,
    listings: -1,
    seats: -1,
    supportContacts: -1,
    supportPremiumContacts: -1,
    eventRetentionDays: -1,
    doraRetentionDays: -1,
  },
};

// -----------------------------------------------------------------------------
// Tier-ladder facts the browser decides with too
// -----------------------------------------------------------------------------

/** Tiers that permit the org → team hierarchy (nesting teams under a root). The
 *  billing-off `unlimited` tier is team-capable (it's the most permissive); the
 *  entry-level `developer`/`pro` tiers are not. Single source for the parent-
 *  eligibility + downgrade-overcap checks so they can't drift. */
export const TEAM_CAPABLE_TIERS: readonly QuotaTier[] = ['team', 'business', 'enterprise', 'unlimited'];
export function tierAllowsTeams(tier: string | undefined | null): boolean {
  return !!tier && (TEAM_CAPABLE_TIERS as readonly string[]).includes(tier);
}

/** Tiers that may buy extra seats — billing's per-seat `seat` add-on. Seats are
 *  the Team differentiator, so the single-seat `developer`/`pro` tiers cannot
 *  stack them and must upgrade instead; `unlimited` has no seat cap at all.
 *  Single source for the billing catalog and every "out of seats" message. */
export const SEAT_PACK_TIERS: readonly QuotaTier[] = ['team', 'business', 'enterprise'];

/** How an account that has used every seat can get another. */
export type SeatRemedy = 'upgrade' | 'seat_pack';

/**
 * The remedy to offer an account at its seat cap, from the ACCOUNT's (root) tier:
 * `seat_pack` where seats can be bought, `upgrade` on the single-seat tiers.
 * `null` when the tier is unknown or has no cap — say nothing rather than guess.
 */
export function seatRemedy(tier: string | undefined | null): SeatRemedy | null {
  if (!tier || !Object.hasOwn(DEFAULT_TIER_LIMITS, tier) || tier === 'unlimited') return null;
  return (SEAT_PACK_TIERS as readonly string[]).includes(tier) ? 'seat_pack' : 'upgrade';
}
