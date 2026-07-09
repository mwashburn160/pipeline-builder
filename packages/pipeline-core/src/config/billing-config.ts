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
 * All defaults match the original hardcoded seed data for backward compatibility.
 */
import { QUOTA_TIERS, isValidTier, type QuotaTier, type QuotaTierLimits } from '@pipeline-builder/api-core';
import type { BillingConfig, BillingPlanConfig, BundleConfig } from './config-types.js';

/** Per-unit quota deltas for a bundle — keys constrained to real quota fields
 *  (matches `BundleConfig.grants`), so a typo'd dimension fails to compile. */
type GrantMap = Partial<Record<keyof QuotaTierLimits, number>>;

// -- Default features ---------------------------------------------------------
// Derived from each tier's EFFECTIVE quota limits so the marketing copy stays
// honest when limits change (including via QUOTA_TIER_* env overrides). Per-tier
// perks (support level, dashboards, etc.) are appended.

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
    ...perks,
  ];
}

const DEFAULT_DEVELOPER_FEATURES = defaultFeatures('developer', ['Community support']);
const DEFAULT_PRO_FEATURES = defaultFeatures('pro', ['Community support', 'Reporting dashboard']);
const DEFAULT_TEAM_FEATURES = defaultFeatures('team', [
  'RBAC & team roles', 'SSO / IdP configs', 'Audit log', 'Priority support',
]);
const DEFAULT_ENTERPRISE_FEATURES = defaultFeatures('enterprise', [
  'RBAC & team roles', 'SSO / IdP configs', 'Audit log',
  'Priority support', 'Reporting dashboard', 'Custom integrations',
]);

/**
 * Parse a price (in cents) from an env var, falling back to the default when
 * unset OR malformed. A NaN (e.g. `BILLING_PLAN_PRO_MONTHLY=abc`) must never
 * flow into the returned config as a price.
 */
function envCents(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined || envVar === '') return fallback;
  const n = parseInt(envVar, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Parse a JSON array from an env var, falling back to default.
 */
function parseFeatures(envVar: string | undefined, fallback: string[]): string[] {
  if (!envVar) return fallback;
  try {
    const parsed = JSON.parse(envVar);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Load billing plan configuration from environment variables.
 */
export function loadBillingConfig(): BillingConfig {
  const plans: BillingPlanConfig[] = [
    {
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
    {
      id: 'pro',
      name: process.env.BILLING_PLAN_PRO_NAME || 'Pro',
      description: process.env.BILLING_PLAN_PRO_DESCRIPTION
        || 'For individual power users and production workloads',
      tier: 'pro',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_PRO_MONTHLY, 1900),
        annual: envCents(process.env.BILLING_PLAN_PRO_ANNUAL, 19000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_PRO_FEATURES,
        DEFAULT_PRO_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 1,
    },
    {
      id: 'team',
      name: process.env.BILLING_PLAN_TEAM_NAME || 'Team',
      description: process.env.BILLING_PLAN_TEAM_DESCRIPTION
        || 'For teams collaborating on shared pipelines',
      tier: 'team',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_TEAM_MONTHLY, 4900),
        annual: envCents(process.env.BILLING_PLAN_TEAM_ANNUAL, 49000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_TEAM_FEATURES,
        DEFAULT_TEAM_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 2,
    },
    {
      id: 'enterprise',
      name: process.env.BILLING_PLAN_ENTERPRISE_NAME || 'Enterprise',
      description: process.env.BILLING_PLAN_ENTERPRISE_DESCRIPTION
        || 'Org-wide scale with unlimited seats and priority support',
      tier: 'enterprise',
      prices: {
        monthly: envCents(process.env.BILLING_PLAN_ENTERPRISE_MONTHLY, 9900),
        annual: envCents(process.env.BILLING_PLAN_ENTERPRISE_ANNUAL, 99000),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_ENTERPRISE_FEATURES,
        DEFAULT_ENTERPRISE_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 3,
    },
  ];

  return { plans, bundles: loadBundles() };
}

const BUNDLE_GB = 1024 * 1024 * 1024;

/**
 * Apply a per-bundle grant override. Each stackable pack grants exactly one
 * quota dimension, so `BILLING_BUNDLE_<ID>_GRANT` retunes that amount (e.g. make
 * the Seat Pack grant +10 instead of +5) — parallel to the price overrides.
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
    extra: { features?: string[]; stackable?: boolean } = {},
  ): BundleConfig => {
    // Resolve monthly first so the annual fallback tracks a `_MONTHLY` override
    // (annual ≈ 10× the *effective* monthly, not the hardcoded default).
    const resolvedMonthly = envCents(process.env[`BILLING_BUNDLE_${id.toUpperCase()}_MONTHLY`], monthly);
    return {
      id,
      name,
      description,
      grants: applyGrantOverride(id, grants),
      ...(extra.features ? { features: extra.features } : {}),
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

  const ALL: QuotaTier[] = ['developer', 'pro', 'team', 'enterprise'];
  return [
    // Capacity packs (seats/pipelines/plugins) are available on EVERY tier so any
    // account — including free (developer) — can expand in place. Feature bundles
    // (audit_log/sso) and rate packs stay tier-scoped by default.
    b('seat_pack', 'Seat Pack (+5)', '5 additional member seats', { seats: 5 }, 2500, ALL, 0),
    b('pipeline_pack', 'Pipeline Pack (+10)', '10 additional pipelines', { pipelines: 10 }, 1500, ALL, 1),
    b('plugin_pack', 'Plugin Pack (+100)', '100 additional plugins', { plugins: 100 }, 1000, ALL, 2),
    b('api_pack', 'API Pack (+1M)', '1,000,000 additional API calls / period', { apiCalls: 1_000_000 }, 2000, ['developer', 'pro'], 3),
    b('ai_pack', 'AI Pack (+5k)', '5,000 additional AI calls / period', { aiCalls: 5000 }, 3000, ALL, 4),
    b('storage_pack', 'Storage Pack (+50 GB)', '50 GB additional registry storage', { storageBytes: 50 * BUNDLE_GB }, 1000, ALL, 5),
    b('audit_log', 'Audit Log', 'Audit log capability', {}, 2000, ['pro'], 6, { features: ['audit_log'], stackable: false }),
    b('sso', 'SSO / IdP', 'SSO + up to 5 IdP configs', { idpConfigs: 5 }, 4000, ['pro', 'team'], 7, { features: ['sso'], stackable: false }),
  ];
}
