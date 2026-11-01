// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Load billing plan configuration from environment variables.
 *
 * Per-plan prices are the most likely to vary between environments:
 *   BILLING_PLAN_{TIER}_MONTHLY / BILLING_PLAN_{TIER}_ANNUAL  (in cents)
 *
 * Optional overrides for descriptions and features:
 *   BILLING_PLAN_{TIER}_NAME          (plain string, display name)
 *   BILLING_PLAN_{TIER}_DESCRIPTION   (plain string)
 *   BILLING_PLAN_{TIER}_FEATURES      (JSON string array)
 *
 * All defaults match the original hardcoded seed data.
 */
import { QUOTA_RESET_DAYS, QUOTA_TIERS, TIER_FEATURES, FEATURE_METADATA, SUPPORT_RESPONSE_TARGETS, VALID_TIERS, STANDARD_TIERS, SEAT_PACK_TIERS, envBool, isValidFeatureFlag, isValidTier, type QuotaTier, type QuotaTierLimits } from '@pipeline-builder/api-core';
import type { BillingConfig, BillingPlanConfig, BundleConfig, ComboDiscountConfig } from './billing-types.js';
import { snapUpPrice } from '../helpers/price-rounding.js';

/** Per-unit quota deltas for a bundle — keys constrained to real quota fields
 *  (matches `BundleConfig.grants`), so a typo'd dimension fails to compile. */
type GrantMap = Partial<Record<keyof QuotaTierLimits, number>>;

// -- Default features ---------------------------------------------------------
// The marketed feature list is built from two derived sources so it can never
// drift from what the platform actually enforces:
//   1. LIMIT lines derived from each tier's EFFECTIVE quota limits (QUOTA_TIERS),
//      so they track QUOTA_TIER_* env overrides.
//   2. INCLUDED-FEATURE lines derived from the enforced entitlement set
//      (TIER_FEATURES) via FEATURE_METADATA labels — so an advertised base
//      feature is always one `requireFeature` actually grants for that tier.
// Only genuinely non-gated marketing copy (support level, dashboards, RBAC) is
// hand-authored, passed as `perks`. Purchasable feature add-ons
// (advanced_reporting, team_usage_analytics, compliance_*) are NOT listed as
// base perks here — they are sold as bundles (see loadBundles()). `sso` is the
// other way round: a TIER feature only (Team+), never a bundle, so it DOES
// appear as a derived base perk on the tiers that include it.

/**
 * The reset window, spelled for a plan card: "every 3 days", or "a day" at 1.
 *
 * Derived from `QUOTA_RESET_DAYS` rather than written out, so a deployment that
 * retunes the window cannot leave the pricing copy claiming the old one.
 */
function periodPhrase(): string {
  return QUOTA_RESET_DAYS === 1 ? 'a day' : `every ${QUOTA_RESET_DAYS} days`;
}

/**
 * "Up to N plugins" / "Unlimited plugins" from an effective limit (-1 = unlimited).
 *
 * `rate` NAMES THE WINDOW, and leaving it off a rate dimension is the bug this
 * parameter exists to prevent. Only `seats` is a stock; plugins is BUILDS per
 * period, pipelines is CREATIONS per period, and the API/AI caps are per-period
 * rates too. All five lines sit on a plan card beside a MONTHLY price, so an
 * unlabelled "Up to 300,000 API calls" reads as monthly when it is the allowance
 * per `QUOTA_RESET_DAYS` — a tenfold understatement of what the tier gives at the
 * default 3-day window, which under-sells the plan and invites a dispute the
 * first time somebody divides the invoice by the number.
 */
function limitLine(limit: number, singular: string, plural: string, rate = false): string {
  const per = rate ? ` ${periodPhrase()}` : '';
  if (limit === -1) return `Unlimited ${plural}`;
  return `Up to ${limit.toLocaleString('en-US')} ${limit === 1 ? singular : plural}${per}`;
}

function defaultFeatures(tier: QuotaTier, perks: string[]): string[] {
  const l = QUOTA_TIERS[tier].limits;
  return [
    // Seats are the one STOCK here — a headcount you hold, not a rate you spend.
    limitLine(l.seats, 'seat', 'seats'),
    limitLine(l.plugins, 'plugin build', 'plugin builds', true),
    limitLine(l.pipelines, 'pipeline creation', 'pipeline creations', true),
    limitLine(l.apiCalls, 'API call', 'API calls', true),
    limitLine(l.aiCalls, 'AI call', 'AI calls', true),
    // Enforced entitlements → customer-facing labels (single source of truth).
    ...TIER_FEATURES[tier].map((f) => FEATURE_METADATA[f].label),
    ...perks,
  ];
}

// Note: `perks` are non-gated marketing lines only. Enforced features (incl.
// Priority Support for pro/team/enterprise) come from TIER_FEATURES above.
// The reporting dashboard is open to every tier (only the DORA/scorecard views
// are entitlement-gated), so it's listed on each plan rather than implying a
// lower tier lacks it.
const DEFAULT_DEVELOPER_FEATURES = defaultFeatures('developer', ['Community support', 'Reporting dashboard']);
const DEFAULT_PRO_FEATURES = defaultFeatures('pro', ['Reporting dashboard']);
const DEFAULT_TEAM_FEATURES = defaultFeatures('team', ['RBAC & team roles', 'Reporting dashboard']);
const DEFAULT_BUSINESS_FEATURES = defaultFeatures('business', ['RBAC & team roles', 'Reporting dashboard']);
const DEFAULT_ENTERPRISE_FEATURES = defaultFeatures('enterprise', [
  'RBAC & team roles', 'Reporting dashboard',
]);
// Unlimited includes every feature (TIER_FEATURES.unlimited = all).
const DEFAULT_UNLIMITED_FEATURES = defaultFeatures('unlimited', [
  'Unlimited everything', 'RBAC & team roles', 'Reporting dashboard',
]);

/**
 * Parse a price (in cents) from an env var, falling back to the default when
 * unset OR malformed. A NaN (e.g. `BILLING_PLAN_PRO_MONTHLY=abc`) must never
 * flow into the returned config as a price.
 *
 * EVERY price in the catalog lands here — all twelve plan prices, both halves of
 * every bundle, both halves of every combo — which is why the whole-dollar-or-.99
 * rule is applied at this one point rather than at sixteen call sites. It covers
 * the two cases a literal cannot:
 *
 *  - the DERIVED annual, passed in as `resolvedMonthly * 10`. That convention
 *    turns every `.99` monthly price into a `.90` annual one, which is where most
 *    of the odd cents in this catalog came from: $19.99/mo arrived as $199.90/yr.
 *  - an OPERATOR override. `BILLING_BUNDLE_SEAT_MONTHLY=4950` is a plausible
 *    thing to type and would otherwise put $49.50 on an invoice.
 *
 * Snapping here also means the literals below and the runtime values agree, so
 * reading the source tells you what a customer is charged.
 */
function envCents(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined || envVar === '') return snapUpPrice(fallback);
  // `parseInt` is too lenient here: '49.99'→49, '49abc'→49, '-100'→-100 would all
  // flow through as a "price". Require a clean, non-negative integer (cents),
  // matching `applyGrantOverride`'s rigor — anything else falls back.
  const n = Number(envVar);
  return snapUpPrice(Number.isInteger(n) && n >= 0 ? n : fallback);
}

/**
 * Parse a JSON array from an env var, falling back to default.
 */
function parseFeatures(envVar: string | undefined, fallback: string[]): string[] {
  if (!envVar) return fallback;
  try {
    const parsed = JSON.parse(envVar);
    // Array-of-strings only — a JSON array of non-strings (e.g. `[1,2]`) must not
    // ship numbers as feature labels. Filter to strings (mirrors applyTiersOverride).
    if (!Array.isArray(parsed)) return fallback;
    const strings = parsed.filter((x): x is string => typeof x === 'string');
    return strings.length === parsed.length ? strings : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Load billing plan configuration from environment variables.
 */
export function loadBillingConfig(): BillingConfig {
  // Keyed by QuotaTier so the compiler forces a plan for EVERY tier — adding a
  // 5th QuotaTier without a plan here is now a compile error (was a hand-kept
  // 4-element array that silently shipped no plan/price for a new tier). The
  // public `config.plans` shape stays an array, derived below in VALID_TIERS
  // order (developer, pro, team, enterprise, unlimited) to preserve consumer ordering.
  const planByTier: Record<QuotaTier, BillingPlanConfig> = {
    developer: {
      id: 'developer',
      name: process.env.BILLING_PLAN_DEVELOPER_NAME || 'Developer',
      description: process.env.BILLING_PLAN_DEVELOPER_DESCRIPTION
        || 'Free starter tier for individual developers',
      tier: 'developer',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_DEVELOPER_MONTHLY, 0),
        annual: envCents(process.env.BILLING_PLAN_DEVELOPER_ANNUAL, 0),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_DEVELOPER_FEATURES,
        DEFAULT_DEVELOPER_FEATURES,
      ),
      isActive: true,
      isDefault: true,
      sortOrder: 0,
    },
    pro: {
      id: 'pro',
      name: process.env.BILLING_PLAN_PRO_NAME || 'Pro',
      description: process.env.BILLING_PLAN_PRO_DESCRIPTION
        || 'For individual power users and production workloads',
      tier: 'pro',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_PRO_MONTHLY, 3900),
        annual: envCents(process.env.BILLING_PLAN_PRO_ANNUAL, 39000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_PRO_FEATURES,
        DEFAULT_PRO_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 1,
    },
    team: {
      id: 'team',
      name: process.env.BILLING_PLAN_TEAM_NAME || 'Team',
      description: process.env.BILLING_PLAN_TEAM_DESCRIPTION
        || 'For teams collaborating on shared pipelines',
      tier: 'team',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_TEAM_MONTHLY, 7900),
        annual: envCents(process.env.BILLING_PLAN_TEAM_ANNUAL, 79000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_TEAM_FEATURES,
        DEFAULT_TEAM_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 2,
    },
    // Business ($249): the rung the $79 -> $899 gap was missing. 8 seats and
    // DORA included; Enterprise keeps custom integrations, team analytics, the
    // compliance libraries and stakeholder reports.
    business: {
      id: 'business',
      name: process.env.BILLING_PLAN_BUSINESS_NAME || 'Business',
      description: process.env.BILLING_PLAN_BUSINESS_DESCRIPTION
        || 'For growing organizations: a higher seat baseline with delivery analytics included',
      tier: 'business',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_BUSINESS_MONTHLY, 24900),
        annual: envCents(process.env.BILLING_PLAN_BUSINESS_ANNUAL, 249000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_BUSINESS_FEATURES,
        DEFAULT_BUSINESS_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 3,
    },
    enterprise: {
      id: 'enterprise',
      name: process.env.BILLING_PLAN_ENTERPRISE_NAME || 'Enterprise',
      description: process.env.BILLING_PLAN_ENTERPRISE_DESCRIPTION
        || 'Org-wide scale with a high seat baseline (expandable via Member Seat add-ons) and priority support',
      tier: 'enterprise',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_ENTERPRISE_MONTHLY, 89900),
        annual: envCents(process.env.BILLING_PLAN_ENTERPRISE_ANNUAL, 899000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_ENTERPRISE_FEATURES,
        DEFAULT_ENTERPRISE_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 4,
    },
    // The billing-DISABLED default plan: everything uncapped, all features, free.
    // Seeded so the tier→plan mapping resolves, but never offered for sale — the
    // read-plans route filters it out (see createReadPlanRoutes), so it's hidden
    // whenever billing is enabled (the only time /plans is served).
    unlimited: {
      id: 'unlimited',
      name: process.env.BILLING_PLAN_UNLIMITED_NAME || 'Unlimited',
      description: process.env.BILLING_PLAN_UNLIMITED_DESCRIPTION
        || 'Everything uncapped — the default when billing is disabled',
      tier: 'unlimited',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_UNLIMITED_MONTHLY, 0),
        annual: envCents(process.env.BILLING_PLAN_UNLIMITED_ANNUAL, 0),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_UNLIMITED_FEATURES,
        DEFAULT_UNLIMITED_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 4,
    },
  };

  // Derive the array consumers read (`config.plans`) in canonical tier order.
  const plans: BillingPlanConfig[] = VALID_TIERS.map((tier) => planByTier[tier]);

  // Build bundles ONCE and thread them into the combo loader (which needs their
  // env-effective prices) — avoids parsing the whole bundle catalog twice per load.
  const bundles = loadBundles();
  return { plans, bundles, comboDiscounts: loadComboDiscounts(bundles) };
}

/**
 * Combo discounts (docs/billing-bundles.md §Combo pricing). When an account owns
 * every member bundle (each at ≥ its minimum quantity), the set is billed at the
 * combined price instead of the sum of the members — realized as a recurring usage
 * credit for the difference. Overlapping combos are resolved by max-weight packing
 * (a shared add-on is never discounted twice); `sortOrder` breaks equal-total ties.
 *
 * Defaults:
 *  - "Analytics Suite" — Advanced Reporting (DORA) + Team Usage Analytics, each
 *    $30/mo, together $42/mo ($420/yr) → a $18/mo credit (~30% off).
 *  - "Team Growth Bundle" — ≥5 Seats ($19.99 ea) + Team Usage Analytics ($30),
 *    basket $129.95/mo → together $90.99/mo ($909.90/yr) → a ~$38.96/mo credit (~30% off).
 *  - "Scale Bundle" — API Pack ($19.99) + Storage Pack ($19.99), basket $39.98/mo
 *    → together $27.99/mo ($279.90/yr) → a ~$11.99/mo credit (~30% off).
 * Prices env-overridable via `BILLING_COMBO_<ID>_MONTHLY` / `_ANNUAL`.
 */
function loadComboDiscounts(bundles: BundleConfig[]): ComboDiscountConfig[] {
  const c = (
    id: string,
    name: string,
    bundleIds: string[],
    monthly: number,
    annual: number,
    sortOrder: number,
    minQuantities?: Record<string, number>,
  ): ComboDiscountConfig => ({
    id,
    name,
    bundleIds,
    ...(minQuantities ? { minQuantities } : {}),
    prices: {
      monthly: envCents(process.env[`BILLING_COMBO_${id.toUpperCase()}_MONTHLY`], monthly),
      annual: envCents(process.env[`BILLING_COMBO_${id.toUpperCase()}_ANNUAL`], annual),
    },
    sortOrder,
    isActive: true,
  });

  const combos = [
    // Analytics Suite — Advanced Reporting ($30) + Team Usage Analytics ($30) +
    // Stakeholder Reports ($30) at 30% off. Basket $90/mo → bundled $63/mo (~$27
    // credit), annual $630 (the 10×-monthly convention: two months free). Adding the
    // reports add-on here is deliberate: a customer who wants delivery analytics AND a
    // way to show them to managers is buying one thing, and the combo is what says so.
    c('analytics_suite', 'Analytics Suite', ['advanced_reporting', 'team_usage_analytics', 'stakeholder_reports'], 6300, 63000, 0),
    // Team Growth — ≥5 Seats ($49.99 ea) + Team Usage Analytics ($30). Basket
    // 5×$49.99 + $30 = $279.95/mo → bundled $195.99/mo (30% off, $83.96 credit).
    //
    // REPRICED WITH THE SEAT, not left alone. The combo credit is
    // `Σ member price × minQty − combined price`, so holding the old $90.99
    // against the new basket would have turned a 30% combo into a 67% one
    // silently — the arithmetic lives in this comment precisely so the two
    // cannot drift apart unnoticed.
    c('team_growth', 'Team Growth Bundle', ['seat', 'team_usage_analytics'], 19599, 195999, 1, { seat: 5 }),
    // Compliance Suite — Standard + Advanced at 30% off ($908.60/yr vs $1,298 list).
    c('compliance_suite', 'Compliance Suite', ['compliance_standard', 'compliance_advanced'], 9099, 90999, 2),
    // Insights Bundle — Team Usage Analytics ($30) + Stakeholder Reports ($30).
    // Basket $60/mo -> bundled $42/mo (30% off, $18 credit).
    //
    // WHY IT EXISTS: the Analytics Suite above needs all THREE of its members
    // purchasable on the buyer's tier, and `advanced_reporting` is INCLUDED in
    // Business — so Business cannot buy it, the Suite can never form there, and
    // a Business account buying the other two paid full list ($60) while Team
    // paid $63 for all three. This is the same pair without the member the tier
    // already owns. Available on Team and Business (the members' intersection);
    // on Team it loses to the Suite's larger $27 credit whenever all three are
    // held, which is exactly the overlap resolution's job.
    c('insights_bundle', 'Insights Bundle', ['team_usage_analytics', 'stakeholder_reports'], 4200, 42000, 4),
    // Throughput Bundle — Plugin + API + AI Pack, $11.99 each. Basket $35.97/mo
    // -> bundled $25.18/mo (30% off, $10.79 credit). The three per-period rate
    // packs had no combo at all, which made the one capacity combo (Scale) an
    // odd pairing of API with storage. Paid tiers only, following its members.
    c('throughput_bundle', 'Throughput Bundle', ['plugin_pack', 'api_pack', 'ai_pack'], 2599, 25999, 5),
    // Scale Bundle — API Pack ($11.99) + Storage Pack ($19.99). Basket $31.98/mo →
    // bundled $22.39/mo (~30% off, ~$9.59 credit). Must be recomputed whenever
    // either member is repriced: a combo priced ABOVE its basket bills more than
    // buying the members separately, which `warnOnNonDiscountCombos` reports at
    // boot. `api_pack` is now paid-tier-only, so this combo is effectively Pro+
    // even though `storage_pack` is all-tier.
    c('scale_bundle', 'Scale Bundle', ['api_pack', 'storage_pack'], 2299, 22999, 3),
    // Assured Delivery — Standard Compliance ($29.90) + 1 Standard Support contact
    // ($19.99). Basket $49.89/mo -> bundled $34.92/mo (30% off, $14.97 credit).
    // The story is "evidence, plus someone to ask about it".
    //
    // The anchor is ONE contact, not several: a contact is not a seat, so one is
    // already a real purchase (contrast `team_growth`, which anchors at 5 seats).
    // Per `minQuantities`' contract the credit basis uses that minimum, so the
    // 30% applies to the first contact and contacts 2+ bill at list — which the
    // pricing page has to say, because discovering it on an invoice is worse.
    // Gated on the same switch as its support member. `assertCombosValid` throws
    // when a combo references an INACTIVE bundle, so without this `SUPPORT_ENABLED=false`
    // would not merely hide the combo — it would stop the billing service booting
    // at all. A deployment switch must never be able to break a config contract.
    ...(supportEnabled
      ? [c('assured_delivery', 'Assured Delivery', ['compliance_standard', 'support_standard'], 3499, 34999, 6, { support_standard: 1 })]
      : []),
  ];
  assertCombosValid(combos, bundles);
  warnOnNonDiscountCombos(combos, bundles);
  return combos;
}

/**
 * Config-load guardrail for combos: every `bundleId` must resolve to an ACTIVE
 * bundle and every `minQuantities` key must be one of the combo's `bundleIds`.
 * A typo'd member or stray minQuantity key otherwise ships a permanently-inert
 * combo (missing bundle treated as unit price 0, or a min never satisfiable),
 * silently never applying. Throws so misconfig fails fast at boot.
 */
export function assertCombosValid(combos: ComboDiscountConfig[], bundles: BundleConfig[]): void {
  const activeIds = new Set(bundles.filter((b) => b.isActive).map((b) => b.id));
  for (const combo of combos) {
    for (const id of combo.bundleIds) {
      if (!activeIds.has(id)) {
        throw new Error(`Combo "${combo.id}" references bundle "${id}", which is not an active bundle.`);
      }
    }
    for (const key of Object.keys(combo.minQuantities ?? {})) {
      if (!combo.bundleIds.includes(key)) {
        throw new Error(`Combo "${combo.id}" minQuantities key "${key}" is not one of its bundleIds.`);
      }
    }
  }
}

/** The volume-discount percent applying to `quantity` units of a bundle — the
 *  highest `volumeTiers` entry whose `minQuantity ≤ quantity`, else 0. Mirrors
 *  `volumeDiscountPct` in api/billing's combo-pricing (which can't be imported the
 *  other way); the combo credit math and this guardrail MUST use the same basis. */
function volumeDiscountPctAt(bundle: BundleConfig | undefined, quantity: number): number {
  let pct = 0;
  for (const t of bundle?.volumeTiers ?? []) if (quantity >= t.minQuantity) pct = t.discountPercent;
  return pct;
}

/**
 * Guardrail: a combo whose combined price is ≥ its minimum-composition basket grants
 * no credit (the credit clamps to $0) and is silently inert. Warn loudly instead so a
 * misconfigured `BILLING_COMBO_*` override is caught. Non-fatal.
 */
function warnOnNonDiscountCombos(combos: ComboDiscountConfig[], bundles: BundleConfig[]): void {
  // Combo members are always bundles; resolve their (env-effective) unit prices once.
  const byId = new Map(bundles.map((b) => [b.id, b]));
  for (const combo of combos) {
    for (const interval of ['monthly', 'annual'] as const) {
      // Post-volume basis (mirrors `comboBasisCents`): a member with volume tiers is
      // basised on its DISCOUNTED unit at the combo's minQty, so this guardrail can't
      // silently miss a combo that grants no real credit once volume is applied.
      const basket = combo.bundleIds.reduce((s, id) => {
        const b = byId.get(id);
        const qty = combo.minQuantities?.[id] ?? 1;
        const rawUnit = b?.prices[interval] ?? 0;
        const unit = Math.round((rawUnit * (100 - volumeDiscountPctAt(b, qty))) / 100);
        return s + unit * qty;
      }, 0);
      if (combo.prices[interval] >= basket) {
        // eslint-disable-next-line no-console
        console.warn(`[billing-config] Combo "${combo.id}" ${interval} price ${combo.prices[interval]} ≥ member basket ${basket}; it grants no discount.`);
      }
    }
  }
}

const BUNDLE_GB = 1024 * 1024 * 1024;

/**
 * Apply a per-bundle grant override. Each stackable pack grants exactly one
 * quota dimension, so `BILLING_BUNDLE_<ID>_GRANT` retunes that amount (e.g. make
 * the Plugin Pack grant +50 instead of +25) — parallel to the price overrides.
 * Ignored for multi-dimension or feature-only (empty-grant) bundles, and for a
 * malformed/negative value.
 */
function applyGrantOverride(id: string, grants: GrantMap): GrantMap {
  const raw = process.env[`BILLING_BUNDLE_${id.toUpperCase()}_GRANT`];
  const keys = Object.keys(grants);
  if (raw === undefined || raw === '' || keys.length !== 1) return grants;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return grants;
  // `keys` came from a GrantMap, so its sole key is a QuotaTierLimits field.
  return { [keys[0] as keyof QuotaTierLimits]: n };
}

/**
 * Apply a per-bundle tier-availability override. `BILLING_BUNDLE_<ID>_TIERS` is a
 * JSON array of tier IDs that may purchase the bundle (e.g. `["developer","pro"]`)
 * — parallel to the price/grant overrides. Falls back to `defaultTiers` when
 * unset, malformed, empty, or containing an unknown tier.
 */
function applyTiersOverride(id: string, defaultTiers: QuotaTier[]): QuotaTier[] {
  const raw = process.env[`BILLING_BUNDLE_${id.toUpperCase()}_TIERS`];
  if (!raw) return defaultTiers;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultTiers;
    const valid = parsed.filter((t): t is QuotaTier => typeof t === 'string' && isValidTier(t));
    return valid.length === parsed.length ? valid : defaultTiers;
  } catch {
    return defaultTiers;
  }
}

type VolumeTier = { minQuantity: number; discountPercent: number };

/**
 * Apply a per-bundle volume-tier override. `BILLING_BUNDLE_<ID>_VOLUME_TIERS` is a
 * JSON array of `{ minQuantity, discountPercent }` (e.g.
 * `[{"minQuantity":5,"discountPercent":10}]`) — parallel to the price/grant/tier
 * overrides. Falls back to `defaultTiers` when unset, malformed, or containing an
 * invalid entry (minQuantity ≥ 1, 0 < discountPercent ≤ 100). Sorted ascending by
 * minQuantity so the "highest matching tier wins" lookup is deterministic.
 */
function applyVolumeTiersOverride(id: string, defaultTiers?: VolumeTier[]): VolumeTier[] | undefined {
  const raw = process.env[`BILLING_BUNDLE_${id.toUpperCase()}_VOLUME_TIERS`];
  const sortAsc = (t: VolumeTier[]) => [...t].sort((a, b) => a.minQuantity - b.minQuantity);
  const fallback = () => (defaultTiers ? sortAsc(defaultTiers) : undefined);
  if (!raw) return fallback();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback();
    // Each entry: integer minQuantity ≥ 1, 0 < discountPercent ≤ 100.
    const valid = parsed.filter((t): t is VolumeTier =>
      t && typeof t.minQuantity === 'number' && Number.isInteger(t.minQuantity) && t.minQuantity >= 1
      && typeof t.discountPercent === 'number' && t.discountPercent > 0 && t.discountPercent <= 100);
    if (valid.length !== parsed.length) return fallback();
    const sorted = sortAsc(valid);
    // Reject a non-monotonic curve: buying MORE must never earn a SMALLER discount,
    // and duplicate thresholds are ambiguous. (`volumeDiscountPct` picks the last
    // qualifying tier, so a descending percent would penalize higher quantities.)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].minQuantity === sorted[i - 1].minQuantity) return fallback();
      if (sorted[i].discountPercent <= sorted[i - 1].discountPercent) return fallback();
    }
    return sorted;
  } catch {
    return fallback();
  }
}

/**
 * Purchasable add-on bundles (docs/billing-bundles.md §3). Grants are per-unit
 * deltas on QuotaTierLimits; prices (cents, `BILLING_BUNDLE_<ID>_MONTHLY` /
 * `_ANNUAL`), the single-dimension grant amount (`BILLING_BUNDLE_<ID>_GRANT`),
 * and the purchasable-tier list (`BILLING_BUNDLE_<ID>_TIERS`) are all
 * env-overridable. Annual ≈ 10× monthly.
 */
/**
 * Default add-on bundle id → Marketplace metered dimension.
 *
 * Mostly identity (dimension named like the bundle id, metering a quantity of
 * "packs purchased"): register these dimensions on the listing, or override the
 * whole map with `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` to translate bundle ids
 * into the listing's actual dimension names.
 *
 * EVERY sellable bundle in src/config/billing-config.ts must appear here. A bundle
 * missing from this map — with no env override — is granted to the customer and
 * then NEVER metered on Marketplace, i.e. given away. `stakeholder_reports` shipped
 * in exactly that state because nothing checked; billing-config.test.ts now asserts
 * the two stay in sync.
 *
 * Exported so that test can see it. At runtime read
 * `config.marketplace.bundleToDimensionMap`, which honours the env override.
 */
export const DEFAULT_BUNDLE_DIMENSION_MAP: Record<string, string> = {
  seat: 'seat',
  pipeline_pack: 'pipeline_pack',
  plugin_pack: 'plugin_pack',
  api_pack: 'api_pack',
  ai_pack: 'ai_pack',
  storage_pack: 'storage_pack',
  listing_pack: 'listing_pack',
  // Feature add-ons that are INCLUDED in Enterprise/Unlimited but sold to lower
  // tiers — metered "packs purchased" (quantity 1) for Marketplace.
  advanced_reporting: 'advanced_reporting',
  team_usage_analytics: 'team_usage_analytics',
  compliance_standard: 'compliance_standard',
  compliance_advanced: 'compliance_advanced',
  stakeholder_reports: 'stakeholder_reports',
  // Retention add-ons (metered "packs purchased"). The reporting retention-sync
  // leg carries the effective days; these dimensions meter the purchase for
  // Marketplace-billed accounts.
  retention_pack: 'RetentionPack',
  dora_history_pack: 'DoraHistoryPack',
  // Support levels. Metered per CONTACT, so the quantity reported is the contact
  // count — unlike the feature add-ons above, which meter quantity 1.
  support_standard: 'support_standard',
  support_priority: 'support_priority',
  support_premium: 'support_premium',
};

/**
 * Whether this DEPLOYMENT sells support at all. ON by default.
 *
 * A deployment that does NOT staff support must set this `false` explicitly —
 * notably a self-hosted install, which has no vendor behind it and would
 * otherwise advertise a purchasable support SKU that routes nowhere. The default
 * assumes the vendor's own deployment, where support is the product.
 *
 * Disabling marks the three `support_*` bundles `isActive: false` and withdraws
 * the `assured_delivery` combo. The rows STAY in the catalog: the Marketplace
 * dimension map is validated in both directions, so removing them would turn a
 * deployment switch into a catalog contract break.
 *
 * Read from `process.env` rather than this service's resolved `config`, because
 * `config.ts` loads THIS module; importing it back would be a cycle.
 */
const supportEnabled = envBool('SUPPORT_ENABLED', true);

/**
 * Whether the 24×7 level is offered. ON by default.
 *
 * Still gated on `supportEnabled`, because "premium only, no ladder" is the one
 * combination with nothing coherent behind it.
 *
 * OPERATIONAL NOTE, not a code concern: premium sells around-the-clock coverage,
 * which is a staffing rota rather than a code path. There IS now a pager
 * integration (PagerDuty Events v2 — see docs/oncall-paging.md), but it is
 * opt-in on `ONCALL_ENABLED` and defaults OFF, so this flag defaulting ON still
 * means a fresh deployment sells a 24×7 target with nothing rostered against
 * it. That is a legitimate choice for a vendor already on call elsewhere, and
 * `OnCallCasesBreachingUnpaged` makes it a visible one rather than an implicit
 * one. A deployment with no overnight rota at all should set this `false` so
 * the SKU is withheld while the catalog stays complete.
 */
const supportPremiumEnabled = supportEnabled && envBool('SUPPORT_PREMIUM_ENABLED', true);

function loadBundles(): BundleConfig[] {
  const b = (
    id: string,
    name: string,
    description: string,
    grants: GrantMap,
    monthly: number,
    availableForTiers: QuotaTier[],
    sortOrder: number,
    extra: { features?: string[]; stackable?: boolean; maxQuantity?: number; requires?: string[]; requiresAnyOf?: string[]; requiresFeatures?: string[]; volumeTiers?: VolumeTier[]; isActive?: boolean } = {},
  ): BundleConfig => {
    // Resolve monthly first so the annual fallback tracks a `_MONTHLY` override
    // (annual ≈ 10× the *effective* monthly, not the hardcoded default).
    const resolvedMonthly = envCents(process.env[`BILLING_BUNDLE_${id.toUpperCase()}_MONTHLY`], monthly);
    const volumeTiers = applyVolumeTiersOverride(id, extra.volumeTiers);
    return {
      id,
      name,
      description,
      grants: applyGrantOverride(id, grants),
      ...(extra.features ? { features: extra.features } : {}),
      ...(extra.maxQuantity !== undefined ? { maxQuantity: extra.maxQuantity } : {}),
      ...(extra.requires ? { requires: extra.requires } : {}),
      ...(extra.requiresAnyOf ? { requiresAnyOf: extra.requiresAnyOf } : {}),
      ...(extra.requiresFeatures ? { requiresFeatures: extra.requiresFeatures } : {}),
      ...(volumeTiers ? { volumeTiers } : {}),
      prices: {
        monthly: resolvedMonthly,
        annual: envCents(process.env[`BILLING_BUNDLE_${id.toUpperCase()}_ANNUAL`], resolvedMonthly * 10),
      },
      stackable: extra.stackable ?? true,
      availableForTiers: applyTiersOverride(id, availableForTiers),
      // `isActive: false` is how a bundle becomes unpurchasable: the addon
      // catalog, the combo validator and the Marketplace dimension check all
      // filter on it already, so a deployment switch needs no new mechanism.
      // The row stays in the catalog, which keeps its Marketplace dimension
      // valid and the ladder documented.
      isActive: extra.isActive ?? true,
      sortOrder,
    };
  };

  // Bundles are purchasable on every SELECTABLE tier (excludes `unlimited`, which
  // is the billing-off tier and buys nothing) — so this is exactly STANDARD_TIERS.
  const ALL: QuotaTier[] = [...STANDARD_TIERS];
  // Capacity packs are NOT sold on `developer`. It is the $0 tier, and any pack
  // grant large enough to be worth selling is large relative to a free tier's
  // own rate — so a free account could out-buy a paid one on a single
  // dimension for the price of the pack (with the pre-resize grants, $10 of
  // Plugin Pack took Developer to 35 plugin builds/period, past Team's 30 at
  // $79). That is a conversion leak, not expansion revenue: the free tier's
  // path up is an UPGRADE. Same reasoning that already keeps `seat` and
  // `pipeline_pack` at Team+, applied to the rest of the capacity packs.
  // `storage_pack` stays on ALL: at +10 GB it cannot cross a tier boundary
  // (Developer 2 GB + 10 GB = 12 GB, still under Pro's 25 GB).
  const PAID: QuotaTier[] = ALL.filter((t) => t !== 'developer');
  // Volume breaks on the capacity packs, mirroring `seat`. The grants below are
  // ~a third of Pro's own rate, so a buyer with real headroom needs 4-6 packs
  // where one oversized pack used to do; priced linearly that is strictly worse
  // for them than the old catalog, which is not the point of the resize.
  // Support is priced per CONTACT, and contacts live in 1..20 — not 1..100 like
  // seats — so the `seat` curve (>=5/15/40) would barely engage. Recut for the
  // range it actually sees; at $19.99+ a unit these are real money (-20% on 8
  // standard contacts is ~$32/mo), which is the point of having them.
  //
  // THE CURVE FLATTENS AS THE LEVEL RISES, and it is the only volume curve in
  // the catalog that does. A volume break is justified when unit cost falls with
  // scale, which is true of capacity (one more pipeline slot costs almost
  // nothing) and false of support: cost per contact does not fall with the
  // count, it RISES with the coverage the level promises. Run flat across all
  // three and the same percentage becomes five times the money at the top — a
  // uniform -30% at 20 contacts took premium from $1,999.80 to $1,399.86 a
  // month, giving away $600 to precisely the customers whose case volume the
  // seven-day rota has to absorb. So standard keeps the full curve (it is the
  // attach-rate lever and its marginal case is cheap), priority stops at -20%,
  // and premium stops at -10%.
  //
  // The caps also protect the ANNUAL stack. Annual is 10x monthly (~17% off) and
  // the volume percent comes off the annual price too, so an uncapped -30% put
  // 20 annual premium contacts at 41.7% below monthly list.
  const SUPPORT_VOLUME_STANDARD: VolumeTier[] = [
    { minQuantity: 3, discountPercent: 10 },
    { minQuantity: 8, discountPercent: 20 },
    { minQuantity: 20, discountPercent: 30 },
  ];
  const SUPPORT_VOLUME_PRIORITY: VolumeTier[] = [
    { minQuantity: 3, discountPercent: 10 },
    { minQuantity: 8, discountPercent: 20 },
  ];
  const SUPPORT_VOLUME_PREMIUM: VolumeTier[] = [
    { minQuantity: 3, discountPercent: 10 },
  ];
  const CAPACITY_VOLUME: VolumeTier[] = [
    { minQuantity: 4, discountPercent: 10 },
    { minQuantity: 10, discountPercent: 20 },
    { minQuantity: 25, discountPercent: 30 },
  ];
  const bundles: BundleConfig[] = [
    // `seat` and `pipeline_pack` are the tier differentiators, so both are Team+
    // ONLY — a single-seat Developer/Pro can't cheaply stack seats/pipelines to
    // undercut Team (3 seats / 6 pipelines); they must upgrade. `seat` is granular
    // (per-seat) with volume tiers (5/15/40 → 10/20/30%). The other capacity
    // packs are not differentiators, but they are still not sold on the $0 tier
    // (see PAID above) — only `storage_pack`, whose grant is too small to cross
    // a tier boundary, remains on ALL.
    // Tier list from api-core's SEAT_PACK_TIERS: every "out of seats" message
    // offers a seat pack exactly where this bundle is sold, and upgrade elsewhere.
    //
    // GRANTS CAPACITY WITH THE SEAT, for the same reason `pipeline_pack` below
    // grants plugins with pipelines. Every paid tier holds EXACTLY 100,000 API
    // calls and 200 AI calls per seat — pro 1/100k/200, team 3/300k/600,
    // business 8/800k/1600, enterprise 15/1.5M/3000 — so a seats-only pack
    // broke that invariant for anyone who bought it: a Team account at 3 seats
    // plus 12 packs reached 15 seats still sharing 300k API calls, 20k per seat
    // against enterprise's 100k at the same headcount, and nothing told the
    // buyer. Granting the per-seat share keeps a bought seat worth what a tier
    // seat is worth.
    //
    // PRICED AT $49.99, which is the one judgment call here. $19.99 bought a
    // seat alone; restoring tier parity by hand cost $19.99 + 4 api_pack
    // ($47.96) + 2 ai_pack ($23.98) = $91.93, so the old price gave away 4.6x
    // its value once the invariant is honoured. $49.99 sits between the ladder's
    // own implied seat prices — $34.00 team->business, $92.86
    // business->enterprise — and the volume curve converges on the cheaper end:
    // at 40+ seats the 30% tier lands at $34.99, essentially the
    // team->business rate. Upgrading therefore stays better value per seat than
    // stacking packs, which is the direction the ladder should pull.
    // Override with BILLING_BUNDLE_SEAT_MONTHLY to pin the old price.
    b('seat', 'Member Seat', '1 additional member seat, with the same API/AI capacity a tier seat carries', { seats: 1, apiCalls: 100_000, aiCalls: 200 }, 4999, [...SEAT_PACK_TIERS], 0,
      { volumeTiers: [{ minQuantity: 5, discountPercent: 10 }, { minQuantity: 15, discountPercent: 20 }, { minQuantity: 40, discountPercent: 30 }] }),
    // Grants BOTH dimensions on purpose. Every capacity cap is a per-period
    // RATE, and the tiers hold plugins at 5x pipelines; a pipelines-only pack
    // broke that ratio for anyone who bought it (Team went to 11 pipeline
    // creations against an unchanged 30 plugin builds, 2.7:1), so the pipelines
    // it sold could not be built for. At $29.99 it is the dearest pack, which is
    // the point: pipelines are the Team differentiator, so the pack that adds
    // them should never be the cheap way around an upgrade.
    // NOTE: multi-dimension, so `BILLING_BUNDLE_PIPELINE_PACK_GRANT` no longer
    // applies (applyGrantOverride ignores anything but a single-key grant) —
    // override `_MONTHLY`/`_TIERS`, or change the ratio here.
    b('pipeline_pack', 'Pipeline Pack (+5 pipelines, +25 plugins)', '5 additional pipeline creations / period, with the 25 plugin builds to equip them', { pipelines: 5, plugins: 25 }, 2999, ['team', 'business', 'enterprise'], 1),
    // Sized against PRO's rate — the cheapest tier that may buy them — at
    // roughly a third each, so one pack is a top-up and not a second
    // subscription. Before the resize every one of these was exactly 100% of
    // Pro's own rate (Pro held 25 plugins / 100k API / 2.5k AI, the packs
    // granted 25 / 100k / 2.5k), so a single $10-$20 pack doubled the tier.
    b('plugin_pack', 'Plugin Pack (+10)', '10 additional plugin builds / period', { plugins: 10 }, 1199, PAID, 2, { volumeTiers: CAPACITY_VOLUME }),
    b('api_pack', 'API Pack (+25k)', '25,000 additional API calls / period', { apiCalls: 25_000 }, 1199, PAID, 3, { volumeTiers: CAPACITY_VOLUME }),
    // Flat $11.99 across the three throughput packs, so the AI grant is by far
    // the smallest: at $0.12/call it is the only one priced off an EXTERNAL
    // marginal cost rather than our own compute. The tier allowances were cut 5x
    // for the same reason — at the previous 1,000/period for Pro, a fully
    // consumed AI allowance cost more per month than the $39 subscription.
    // +100 is also the ceiling the sizing guard allows: Pro holds 200/period and
    // no pack may exceed half a buyer's own cap.
    b('ai_pack', 'AI Pack (+100)', '100 additional AI calls / period', { aiCalls: 100 }, 1199, PAID, 4, { volumeTiers: CAPACITY_VOLUME }),
    b('storage_pack', 'Storage Pack (+10 GB)', '10 GB additional registry storage', { storageBytes: 10 * BUNDLE_GB }, 1999, ALL, 5),
    // Plugin-ecosystem publishing capacity (docs/plugin-publishing.md):
    // +10 active public listings on top of the tier's `listings` count quota.
    // Not a tier differentiator (installing is free everywhere, and Verified is
    // earned by review, not bought), so it's sold on every tier. $4.99/mo
    // (annual ≈ 10× = $49.90/yr). Removing packs below the org's active listing
    // count is refused by billing's over-cap guard.
    // FREE. Ecosystem publishing is not monetized: installing is free on every
    // tier, and the Verified trust tier is earned by review rather than bought,
    // so charging for the capacity to publish taxed the one thing that grows the
    // catalog for everybody. $0 with the volume tiers dropped (a discount on
    // nothing is noise in the UI).
    //
    // `maxQuantity` is what keeps the `listings` quota meaningful now that the
    // pack costs nothing: without it a free stackable pack is self-service
    // unlimited listings, and the cap — which exists for moderation and registry
    // cost, not revenue — would bind on nobody. 2 packs (+10) roughly doubles
    // Pro and still leaves the tier ladder (10 / 25 / 100) doing the work.
    // Still not offered on `developer`: free-to-buy is not the same as free to
    // hand a $0 account more publishing surface than a paying one.
    b('listing_pack', 'Listing Pack (+5, free)', '5 additional public plugin-ecosystem listings, at no charge', { listings: 5 }, 0, PAID, 6, { maxQuantity: 2 }),
    // NOTE: `sso` is NOT sold as an add-on. It is a TIER feature from Team up
    // (TIER_FEATURES.team) and nothing below Team can buy it. The bundle that
    // used to exist here was $40/mo on Pro only — Pro ($39) + the add-on came to
    // exactly Team ($79), which already includes SSO *and* teams *and* domain
    // registration, so it was strictly dominated. It was also functionally
    // broken below Team: SSO refuses an identity whose email domain the org has
    // not DNS-verified (`assertSsoIdentityTrusted`, which exempts only
    // Google-issued identities), and registering a domain to verify is ITSELF a
    // hard Team/Enterprise tier check (platform `org-domain-service`). So a Pro
    // buyer's Okta / Entra / generic-OIDC / SAML connection failed at callback
    // with OIDC_EMAIL_DOMAIN_NOT_VERIFIED, with no way to fix it on Pro. Selling
    // SSO below Team would mean giving away domain registration too, and that is
    // the Team differentiator.

    // DORA / advanced delivery analytics. INCLUDED in Enterprise (TIER_FEATURES),
    // so the add-on is offered to every other tier (developer/pro/team). Priced
    // as an analytics surface, not an enterprise identity gate.
    // Lead time is MEASURED commit → deploy (reporting's deploy events), not a proxy.
    b('advanced_reporting', 'Advanced Reporting (DORA)', 'DORA delivery metrics — deployment frequency, lead time (commit → deploy), change failure rate, MTTR, performance bands + trend', {}, 3000, ['developer', 'pro', 'team'], 8, { features: ['advanced_reporting'], stackable: false }),
    // Per-team usage breakdown across the org → team subtree. INCLUDED in
    // Enterprise (TIER_FEATURES); the add-on is offered to Team only — Developer
    // and Pro can't nest teams (TEAM_CAPABLE_TIERS), so there'd be nothing to
    // break down. Priced at $30/mo ($300/yr) — parity with DORA, its analytics
    // sibling. Overridable via BILLING_BUNDLE_TEAM_USAGE_ANALYTICS_MONTHLY/_ANNUAL.
    b('team_usage_analytics', 'Team Usage Analytics', 'Per-team usage breakdown across the org → team subtree (all quota dimensions)', {}, 3000, ['team', 'business'], 9, { features: ['team_usage_analytics'], stackable: false }),
    // Retention packs (docs/billing-bundles.md). Stackable capacity packs that
    // raise the reporting retention entitlement billing syncs to reporting's
    // `dora_settings`. NOT quota-metered flow — `eventRetentionDays`/`doraRetentionDays`
    // are absent from VALID_QUOTA_TYPES, so they never ride the quota-service leg.
    // Standard Retention Pack: +90d standard-event retention (base 30 → 120 → 210…).
    // Capped at 7 (30 + 7×90 = 660 ≤ the 730-day retention ceiling).
    b('retention_pack', 'Standard Retention Pack (+90d)', '90 additional days of standard pipeline-event retention', { eventRetentionDays: 90 }, 1500, ALL, 10, { maxQuantity: 7 }),
    // DORA History Pack: +365d DORA retention AND per-org report-query window (the
    // window cap tracks doraRetentionDays). Only meaningful with Advanced Reporting
    // — INCLUDED in Enterprise, an add-on on developer/pro/team — so it
    // `requiresFeatures` it (the tier OR a held bundle satisfies it). Capped at 1
    // (180 + 365 = 545 ≤ the 730-day retention ceiling).
    b('dora_history_pack', 'DORA History Pack (+365d)', '365 additional days of DORA history + report-query window (requires Advanced Reporting)', { doraRetentionDays: 365 }, 3000, ALL, 11, { maxQuantity: 1, requiresFeatures: ['advanced_reporting'] }),
    // Compliance content add-ons (docs/compliance.md). Feature bundles
    // gating access to curated system-org published rule sets. INCLUDED in
    // Enterprise/Unlimited (via ALL_FEATURE_FLAGS); sold to Developer/Pro/Team.
    // Standard = ~20 CI/CD best-practice rules. Advanced = SOC2/PCI/CIS framework
    // libraries; REQUIRES Standard (or buy the Suite combo for both at 30% off).
    b('compliance_standard', 'Standard Compliance', 'Curated CI/CD best-practice compliance rules', {}, 2999, ['developer', 'pro', 'team', 'business'], 12, { features: ['compliance_standard'], stackable: false }),
    b('compliance_advanced', 'Advanced Compliance', 'Curated framework compliance libraries (SOC2 / PCI-DSS / CIS)', {}, 9999, ['developer', 'pro', 'team', 'business'], 13, { features: ['compliance_advanced'], stackable: false, requires: ['compliance_standard'] }),
    // Stakeholder Reports. INCLUDED in Enterprise/Unlimited (ALL_FEATURE_FLAGS);
    // sold to Pro and Team, and deliberately NOT to Developer — a single developer
    // has nobody to report upward to, so the SKU would be an upsell for something
    // they cannot use. Priced at $30/mo, parity with its analytics siblings
    // (advanced_reporting, team_usage_analytics). Overridable via
    // BILLING_BUNDLE_STAKEHOLDER_REPORTS_MONTHLY/_ANNUAL.
    //
    // The free on-demand dashboards are untouched: what this sells is SAVING,
    // SCHEDULING and PUBLISHING a report — a frozen snapshot with the lead's own
    // words on it, delivered to people who mostly have no account here.
    b('stakeholder_reports', 'Stakeholder Reports', 'Scheduled team reports for managers — frozen period snapshots, review and publish, email/Slack/Teams delivery and expiring share links', {}, 3000, ['pro', 'team', 'business'], 14, { features: ['stakeholder_reports'], stackable: false }),
    // Support, priced PER CONTACT — the members authorised to open cases — not per
    // seat. Case volume does not scale with seats (most seats never open a case),
    // so per-seat pricing bills the people who will never contact support: at
    // $19.99 across all seats a 100-seat org would pay ~54% of its plan for
    // STANDARD support. Per contact the same org pays ~3.5%.
    //
    // These are the catalog's FIRST bundles that are both `stackable` and
    // feature-granting. `effectiveEntitlements` already handles it — `features`
    // unions into a Set independent of quantity, while `grants` scales — so the
    // flag is held once and the contact allowance scales with what was bought.
    //
    // `grants: { supportContacts: 1 }` is what makes the quantity MEAN something.
    // With an empty grant the quantity would affect price only, and a 50-seat org
    // could buy one unit, hold the flag, and have nothing report a problem.
    //
    // Offered on ALL tiers, including `developer`: support is an add-on at every
    // tier and included in none. No `availableForTiers` floor is needed because
    // the unit price IS the floor — one premium contact is $99.99, which is AWS
    // Business Support's own $100 minimum.
    // The two BASELINE levels, mutually exclusive, each granting one contact per
    // unit and the shared `support_baseline` flag that premium requires.
    b('support_standard', 'Standard Support', `Support cases with a first response within ${SUPPORT_RESPONSE_TARGETS.support_standard}, business hours — priced per support contact`, { supportContacts: 1 }, 1999, ALL, 15,
      { features: ['support_standard'], volumeTiers: SUPPORT_VOLUME_STANDARD, isActive: supportEnabled }),
    b('support_priority', 'Priority Support', `Support cases with a first response by the ${SUPPORT_RESPONSE_TARGETS.support_priority}, business hours — priced per support contact`, { supportContacts: 1 }, 4999, ALL, 16,
      { features: ['support_priority'], volumeTiers: SUPPORT_VOLUME_PRIORITY, isActive: supportEnabled }),
    // Premium is an UPGRADE, not a third alternative. It grants an upgrade slot
    // rather than a contact, and `requiresAnyOf` is how "standard OR priority"
    // is expressed: `requires` is an AND over bundle ids, and the alternative --
    // inventing a `support_baseline` FEATURE FLAG purely so premium could
    // require it -- would have put a capability that does not exist into every
    // support customer's entitlement list. Price is ADDITIVE on top of the
    // baseline unit ($19.99 + $99.99
    // for a premium contact), because that contact is served during business
    // hours through the baseline and overnight through this; a delta price would
    // pretend the baseline were free, and a list price is far easier to concede
    // down from than to raise.
    b('support_premium', 'Premium Support (upgrade)', `Upgrades a support contact to 24×7 — first response within ${SUPPORT_RESPONSE_TARGETS.support_premium}, and the only contacts who may declare urgent severity. Requires a Standard or Priority Support contact to upgrade; priced per upgraded contact`, { supportPremiumContacts: 1 }, 9999, ALL, 17,
      { features: ['support_premium'], requiresAnyOf: ['support_standard', 'support_priority'], volumeTiers: SUPPORT_VOLUME_PREMIUM, isActive: supportPremiumEnabled }),
  ];
  assertBundleRequiresValid(bundles);
  return bundles;
}

/**
 * Config-load guardrail for the `requires` / `requiresFeatures` prerequisites. A
 * `requires` entry that doesn't resolve to an ACTIVE bundle — or that participates
 * in a cycle — silently makes the referencing bundle unpurchasable (the addon
 * route rejects with 400 forever because the prerequisite can never be
 * satisfied). Catch it at load with a clear error rather than shipping a dead SKU.
 *
 *  - Every id in a bundle's `requires` MUST name an active bundle in the catalog.
 *  - `requiresAnyOf` is an OR, so it needs AT LEAST ONE active member — a member
 *    withdrawn by a deployment switch is fine while another survives, which is
 *    the whole point of the field. All members gone is a dead SKU.
 *  - `requiresAnyOf` must also be satisfiable on every tier the bundle sells to:
 *    at least one alternative has to be offered on that same tier, or the bundle
 *    is purchasable nowhere there.
 *  - The `requires` graph MUST be acyclic (a → b → a can never be satisfied).
 *    `requiresAnyOf` joins that graph: an OR edge can close a cycle just as an
 *    AND edge can.
 *  - Every `requiresFeatures` entry MUST be a real feature flag, attainable on
 *    EVERY tier the bundle is sold to — either tier-included (`TIER_FEATURES`) or
 *    granted by an active bundle offered on that same tier.
 */
export function assertBundleRequiresValid(bundles: BundleConfig[]): void {
  const active = new Map(bundles.filter((b) => b.isActive).map((b) => [b.id, b]));

  // 1. Validity: every requires id resolves to an active bundle.
  //
  // INACTIVE DEPENDENTS ARE SKIPPED, in this check and the two below. A bundle a
  // deployment switch has withdrawn is not purchasable at all, so an
  // unsatisfiable prerequisite on it is irrelevant — whereas throwing would
  // CRASH BILLING AT BOOT. That is not hypothetical: `SUPPORT_ENABLED=false`
  // deactivates the whole support ladder, and premium's `requiresAnyOf` on the
  // two baselines then names nothing active. The `requires` loop had the same
  // latent hole and had simply never been reached, because no inactive bundle
  // happened to declare one. Same shape as the combo guard, which gates
  // `assured_delivery` on `supportEnabled` for exactly this reason.
  for (const bundle of bundles) {
    if (!bundle.isActive) continue;
    for (const reqId of bundle.requires ?? []) {
      if (!active.has(reqId)) {
        throw new Error(
          `[billing-config] Bundle "${bundle.id}" requires "${reqId}", which is not an active bundle in the catalog — it would be permanently unpurchasable.`,
        );
      }
    }
  }

  // 1a. OR prerequisites: at least one active member, offered on every tier the
  // dependent sells to. Checked as a group, not per member: `support_premium`
  // naming both baselines is satisfied while EITHER survives, so requiring every
  // member to be active would make a deployment switch that withdraws one level
  // take the upgrade down with it.
  for (const bundle of bundles) {
    if (!bundle.isActive) continue;
    const anyOf = bundle.requiresAnyOf ?? [];
    if (anyOf.length === 0) continue;
    const live = anyOf.filter((id) => active.has(id));
    if (live.length === 0) {
      throw new Error(
        `[billing-config] Bundle "${bundle.id}" requiresAnyOf [${anyOf.join(', ')}], none of which is an active bundle in the catalog — it would be permanently unpurchasable.`,
      );
    }
    for (const tier of bundle.availableForTiers) {
      if (!live.some((id) => active.get(id)!.availableForTiers.includes(tier))) {
        throw new Error(
          `[billing-config] Bundle "${bundle.id}" requiresAnyOf [${anyOf.join(', ')}], none of which is offered on the ${tier} tier — it would be permanently unpurchasable there.`,
        );
      }
    }
  }

  // 1b. Feature prerequisites: a real flag, attainable on every sold-to tier.
  for (const bundle of bundles) {
    if (!bundle.isActive) continue;
    for (const flag of bundle.requiresFeatures ?? []) {
      if (!isValidFeatureFlag(flag)) {
        throw new Error(`[billing-config] Bundle "${bundle.id}" requiresFeatures "${flag}", which is not a feature flag.`);
      }
      for (const tier of bundle.availableForTiers) {
        const tierIncludes = (TIER_FEATURES[tier] ?? []).includes(flag);
        const buyable = [...active.values()].some((o) => o.availableForTiers.includes(tier) && (o.features ?? []).includes(flag));
        if (!tierIncludes && !buyable) {
          throw new Error(
            `[billing-config] Bundle "${bundle.id}" requires feature "${flag}", which the ${tier} tier neither includes nor can buy — it would be permanently unpurchasable there.`,
          );
        }
      }
    }
  }

  // 2. Acyclicity: DFS over the requires edges, tracking the current path.
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === DONE) return;
    if (s === VISITING) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' -> ');
      throw new Error(`[billing-config] Bundle "requires" cycle detected: ${cycle}.`);
    }
    state.set(id, VISITING);
    const bundle = active.get(id);
    for (const reqId of [...(bundle?.requires ?? []), ...(bundle?.requiresAnyOf ?? [])]) {
      visit(reqId, [...path, id]);
    }
    state.set(id, DONE);
  };

  for (const bundle of active.keys()) {
    visit(bundle, []);
  }
}

let billingConfig: BillingConfig | undefined;

/** The billing plan / bundle / combo catalog, loaded (and validated) once per process. */
export function getBillingConfig(): BillingConfig {
  billingConfig ??= loadBillingConfig();
  return billingConfig;
}
