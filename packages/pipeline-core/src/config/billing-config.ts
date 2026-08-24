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
import { QUOTA_TIERS, TIER_FEATURES, FEATURE_METADATA, VALID_TIERS, STANDARD_TIERS, isValidTier, type QuotaTier, type QuotaTierLimits } from '@pipeline-builder/api-core';
import type { BillingConfig, BillingPlanConfig, BundleConfig, ComboDiscountConfig } from './config-types.js';

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
// hand-authored, passed as `perks`. Purchasable add-ons (sso, audit_log) are NOT
// listed as base perks here — they are sold as bundles (see loadBundles()).

/** "Up to N plugins" / "Unlimited plugins" from an effective limit (-1 = unlimited). */
function limitLine(limit: number, singular: string, plural: string): string {
  if (limit === -1) return `Unlimited ${plural}`;
  return `Up to ${limit.toLocaleString('en-US')} ${limit === 1 ? singular : plural}`;
}

function defaultFeatures(tier: QuotaTier, perks: string[]): string[] {
  const l = QUOTA_TIERS[tier].limits;
  return [
    limitLine(l.seats, 'seat', 'seats'),
    limitLine(l.plugins, 'plugin', 'plugins'),
    limitLine(l.pipelines, 'pipeline', 'pipelines'),
    limitLine(l.apiCalls, 'API call', 'API calls'),
    limitLine(l.aiCalls, 'AI call', 'AI calls'),
    // Enforced entitlements → customer-facing labels (single source of truth).
    ...TIER_FEATURES[tier].map((f) => FEATURE_METADATA[f].label),
    ...perks,
  ];
}

// Note: `perks` are non-gated marketing lines only. Enforced features (incl.
// Priority Support for pro/team/enterprise) come from TIER_FEATURES above.
const DEFAULT_DEVELOPER_FEATURES = defaultFeatures('developer', ['Community support']);
const DEFAULT_PRO_FEATURES = defaultFeatures('pro', ['Reporting dashboard']);
const DEFAULT_TEAM_FEATURES = defaultFeatures('team', ['RBAC & team roles']);
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
 */
function envCents(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined || envVar === '') return fallback;
  // `parseInt` is too lenient here: '49.99'→49, '49abc'→49, '-100'→-100 would all
  // flow through as a "price". Require a clean, non-negative integer (cents),
  // matching `applyGrantOverride`'s rigor — anything else falls back.
  const n = Number(envVar);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
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
    enterprise: {
      id: 'enterprise',
      name: process.env.BILLING_PLAN_ENTERPRISE_NAME || 'Enterprise',
      description: process.env.BILLING_PLAN_ENTERPRISE_DESCRIPTION
        || 'Org-wide scale with unlimited seats and priority support',
      tier: 'enterprise',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_ENTERPRISE_MONTHLY, 59900),
        annual: envCents(process.env.BILLING_PLAN_ENTERPRISE_ANNUAL, 599000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_ENTERPRISE_FEATURES,
        DEFAULT_ENTERPRISE_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 3,
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
    c('analytics_suite', 'Analytics Suite', ['advanced_reporting', 'team_usage_analytics'], 4200, 42000, 0),
    // Team Growth — ≥5 Seats ($19.99 ea) + Team Usage Analytics ($30). Basket
    // 5×$19.99 + $30 = $129.95/mo → bundled $90.99/mo (~30% off, ~$38.96 credit).
    c('team_growth', 'Team Growth Bundle', ['seat', 'team_usage_analytics'], 9099, 90990, 1, { seat: 5 }),
    // Compliance Suite — Standard + Advanced at 30% off ($908.60/yr vs $1,298 list).
    c('compliance_suite', 'Compliance Suite', ['compliance_standard', 'compliance_advanced'], 9086, 90860, 2),
    // Scale Bundle — API Pack ($19.99) + Storage Pack ($19.99). Basket $39.98/mo →
    // bundled $27.99/mo (~30% off, ~$11.99 credit). Both members all-tier.
    c('scale_bundle', 'Scale Bundle', ['api_pack', 'storage_pack'], 2799, 27990, 3),
  ];
  warnOnNonDiscountCombos(combos, bundles);
  return combos;
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
      const basket = combo.bundleIds.reduce((s, id) => s + (byId.get(id)?.prices[interval] ?? 0) * (combo.minQuantities?.[id] ?? 1), 0);
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
  if (!raw) return defaultTiers ? sortAsc(defaultTiers) : undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultTiers ? sortAsc(defaultTiers) : undefined;
    const valid = parsed.filter((t): t is VolumeTier =>
      t && typeof t.minQuantity === 'number' && t.minQuantity >= 1
      && typeof t.discountPercent === 'number' && t.discountPercent > 0 && t.discountPercent <= 100);
    return valid.length === parsed.length ? sortAsc(valid) : (defaultTiers ? sortAsc(defaultTiers) : undefined);
  } catch {
    return defaultTiers ? sortAsc(defaultTiers) : undefined;
  }
}

/**
 * Purchasable add-on bundles (docs/billing-bundles.md §3). Grants are per-unit
 * deltas on QuotaTierLimits; prices (cents, `BILLING_BUNDLE_<ID>_MONTHLY` /
 * `_ANNUAL`), the single-dimension grant amount (`BILLING_BUNDLE_<ID>_GRANT`),
 * and the purchasable-tier list (`BILLING_BUNDLE_<ID>_TIERS`) are all
 * env-overridable. Annual ≈ 10× monthly.
 */
function loadBundles(): BundleConfig[] {
  const b = (
    id: string,
    name: string,
    description: string,
    grants: GrantMap,
    monthly: number,
    availableForTiers: QuotaTier[],
    sortOrder: number,
    extra: { features?: string[]; stackable?: boolean; maxQuantity?: number; requires?: string[]; volumeTiers?: VolumeTier[] } = {},
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
      ...(volumeTiers ? { volumeTiers } : {}),
      prices: {
        monthly: resolvedMonthly,
        annual: envCents(process.env[`BILLING_BUNDLE_${id.toUpperCase()}_ANNUAL`], resolvedMonthly * 10),
      },
      stackable: extra.stackable ?? true,
      availableForTiers: applyTiersOverride(id, availableForTiers),
      isActive: true,
      sortOrder,
    };
  };

  // Bundles are purchasable on every SELECTABLE tier (excludes `unlimited`, which
  // is the billing-off tier and buys nothing) — so this is exactly STANDARD_TIERS.
  const ALL: QuotaTier[] = [...STANDARD_TIERS];
  const bundles: BundleConfig[] = [
    // `seat` and `pipeline_pack` are the tier differentiators, so both are Team+
    // ONLY — a single-seat Developer/Pro can't cheaply stack seats/pipelines to
    // undercut Team (3 seats / 6 pipelines); they must upgrade. `seat` is granular
    // (per-seat) with volume tiers (5/15/40 → 10/20/30%). The other capacity packs
    // (plugin/api/ai/storage) are NOT differentiators, so they stay all-tier.
    b('seat', 'Member Seat', '1 additional member seat', { seats: 1 }, 1999, ['team', 'enterprise'], 0,
      { volumeTiers: [{ minQuantity: 5, discountPercent: 10 }, { minQuantity: 15, discountPercent: 20 }, { minQuantity: 40, discountPercent: 30 }] }),
    b('pipeline_pack', 'Pipeline Pack (+5)', '5 additional pipelines', { pipelines: 5 }, 1500, ['team', 'enterprise'], 1),
    b('plugin_pack', 'Plugin Pack (+25)', '25 additional plugins', { plugins: 25 }, 1000, ALL, 2),
    b('api_pack', 'API Pack (+100k)', '100,000 additional API calls / period', { apiCalls: 100_000 }, 1999, ALL, 3),
    b('ai_pack', 'AI Pack (+2.5k)', '2,500 additional AI calls / period', { aiCalls: 2500 }, 1999, ALL, 4),
    b('storage_pack', 'Storage Pack (+10 GB)', '10 GB additional registry storage', { storageBytes: 10 * BUNDLE_GB }, 1999, ALL, 5),
    b('audit_log', 'Audit Log', 'Audit log capability', {}, 2000, ['pro'], 6, { features: ['audit_log'], stackable: false }),
    // SSO is INCLUDED in Team (see TIER_FEATURES.team), so the add-on is Pro-only.
    b('sso', 'SSO / IdP', 'SSO + up to 5 IdP configs', { idpConfigs: 5 }, 4000, ['pro'], 7, { features: ['sso'], stackable: false }),
    // DORA / advanced delivery analytics. INCLUDED in Enterprise (TIER_FEATURES),
    // so the add-on is offered to every other tier (developer/pro/team). Priced
    // between Audit Log ($20) and SSO ($40) — a higher-value, actively-used
    // analytics surface than the audit log, but below the SSO enterprise gate.
    b('advanced_reporting', 'Advanced Reporting (DORA)', 'DORA delivery metrics — deployment frequency, change failure rate, MTTR, lead-time proxy, performance bands + trend', {}, 3000, ['developer', 'pro', 'team'], 8, { features: ['advanced_reporting'], stackable: false }),
    // Per-team usage breakdown across the org → team subtree. INCLUDED in
    // Enterprise (TIER_FEATURES); the add-on is offered to Pro/Team (developer has
    // no teams to break down). Priced at $30/mo ($300/yr) — parity with DORA, its
    // analytics sibling. Overridable via BILLING_BUNDLE_TEAM_USAGE_ANALYTICS_MONTHLY/_ANNUAL.
    b('team_usage_analytics', 'Team Usage Analytics', 'Per-team usage breakdown across the org → team subtree (all quota dimensions)', {}, 3000, ['pro', 'team'], 9, { features: ['team_usage_analytics'], stackable: false }),
    // Retention packs (docs/billing-bundles.md). Stackable capacity packs that
    // raise the reporting retention entitlement billing syncs to reporting's
    // `dora_settings`. NOT quota-metered flow — `eventRetentionDays`/`doraRetentionDays`
    // are absent from VALID_QUOTA_TYPES, so they never ride the quota-service leg.
    // Standard Retention Pack: +90d standard-event retention (base 30 → 120 → 210…).
    // Capped at 7 (30 + 7×90 = 660 ≤ the 730-day retention ceiling).
    b('retention_pack', 'Standard Retention Pack (+90d)', '90 additional days of standard pipeline-event retention', { eventRetentionDays: 90 }, 1500, ALL, 10, { maxQuantity: 7 }),
    // DORA History Pack: +365d DORA retention AND per-org report-query window (the
    // window cap tracks doraRetentionDays). Only meaningful with Advanced Reporting
    // — INCLUDED in Enterprise, an add-on on developer/pro/team. Capped at 1
    // (180 + 365 = 545 ≤ the 730-day retention ceiling).
    b('dora_history_pack', 'DORA History Pack (+365d)', '365 additional days of DORA history + report-query window (requires Advanced Reporting)', { doraRetentionDays: 365 }, 3000, ALL, 11, { maxQuantity: 1 }),
    // Compliance content add-ons (docs/plans/compliance-addons.md). Feature bundles
    // gating access to curated system-org published rule sets. INCLUDED in
    // Enterprise/Unlimited (via ALL_FEATURE_FLAGS); sold to Developer/Pro/Team.
    // Standard = ~20 CI/CD best-practice rules. Advanced = SOC2/PCI/CIS framework
    // libraries; REQUIRES Standard (or buy the Suite combo for both at 30% off).
    b('compliance_standard', 'Standard Compliance', 'Curated CI/CD best-practice compliance rules', {}, 2990, ['developer', 'pro', 'team'], 12, { features: ['compliance_standard'], stackable: false }),
    b('compliance_advanced', 'Advanced Compliance', 'Curated framework compliance libraries (SOC2 / PCI-DSS / CIS)', {}, 9990, ['developer', 'pro', 'team'], 13, { features: ['compliance_advanced'], stackable: false, requires: ['compliance_standard'] }),
  ];
  assertBundleRequiresValid(bundles);
  return bundles;
}

/**
 * Config-load guardrail for the `requires` prerequisite graph. A `requires` entry
 * that doesn't resolve to an ACTIVE bundle — or that participates in a cycle —
 * silently makes the referencing bundle unpurchasable (the addon route rejects
 * with 400 forever because the prerequisite can never be satisfied). Catch it at
 * load with a clear error rather than shipping a dead SKU.
 *
 *  - Every id in a bundle's `requires` MUST name an active bundle in the catalog.
 *  - The `requires` graph MUST be acyclic (a → b → a can never be satisfied).
 */
export function assertBundleRequiresValid(bundles: BundleConfig[]): void {
  const active = new Map(bundles.filter((b) => b.isActive).map((b) => [b.id, b]));

  // 1. Validity: every requires id resolves to an active bundle.
  for (const bundle of bundles) {
    for (const reqId of bundle.requires ?? []) {
      if (!active.has(reqId)) {
        throw new Error(
          `[billing-config] Bundle "${bundle.id}" requires "${reqId}", which is not an active bundle in the catalog — it would be permanently unpurchasable.`,
        );
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
    for (const reqId of active.get(id)?.requires ?? []) {
      visit(reqId, [...path, id]);
    }
    state.set(id, DONE);
  };

  for (const bundle of active.keys()) {
    visit(bundle, []);
  }
}
