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
import { QUOTA_TIERS, type QuotaTier } from '@pipeline-builder/api-core';
import type { BillingConfig, BillingPlanConfig } from './config-types.js';

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

  return { plans };
}
