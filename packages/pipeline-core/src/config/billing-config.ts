/**
 * Load billing plan configuration from environment variables.
 *
 * Per-plan prices are the most likely to vary between environments:
 *   BILLING_PLAN_{TIER}_MONTHLY / BILLING_PLAN_{TIER}_ANNUAL  (in cents)
 *
 * Optional overrides for descriptions and features:
 *   BILLING_PLAN_{TIER}_DESCRIPTION   (plain string)
 *   BILLING_PLAN_{TIER}_FEATURES      (JSON string array)
 *
 * All defaults match the original hardcoded seed data for backward compatibility.
 */
import type { BillingConfig, BillingPlanConfig } from './config-types';

// -- Default features (match original seed-plans.ts) -------------------------

const DEFAULT_DEVELOPER_FEATURES = [
  'Up to 100 plugins',
  'Up to 10 pipelines',
  'Unlimited API calls',
  'Community support',
];

const DEFAULT_PRO_FEATURES = [
  'Up to 1,000 plugins',
  'Up to 100 pipelines',
  'Unlimited API calls',
  'Community support',
  'Reporting dashboard',
];

const DEFAULT_UNLIMITED_FEATURES = [
  'Unlimited plugins',
  'Unlimited pipelines',
  'Unlimited API calls',
  'Priority support',
  'Reporting dashboard',
  'Custom integrations',
];

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
      name: 'Developer',
      description: process.env.BILLING_PLAN_DEVELOPER_DESCRIPTION
        || 'Free starter tier for individual developers',
      tier: 'developer',
      prices: {
        monthly: parseInt(process.env.BILLING_PLAN_DEVELOPER_MONTHLY || '0', 10),
        annual: parseInt(process.env.BILLING_PLAN_DEVELOPER_ANNUAL || '0', 10),
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
      name: 'Pro',
      description: process.env.BILLING_PLAN_PRO_DESCRIPTION
        || 'For teams and production workloads',
      tier: 'pro',
      prices: {
        monthly: parseInt(process.env.BILLING_PLAN_PRO_MONTHLY || '799', 10),
        annual: parseInt(process.env.BILLING_PLAN_PRO_ANNUAL || '7990', 10),
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
      id: 'unlimited',
      name: 'Unlimited',
      description: process.env.BILLING_PLAN_UNLIMITED_DESCRIPTION
        || 'No restrictions for enterprise teams',
      tier: 'unlimited',
      prices: {
        monthly: parseInt(process.env.BILLING_PLAN_UNLIMITED_MONTHLY || '1199', 10),
        annual: parseInt(process.env.BILLING_PLAN_UNLIMITED_ANNUAL || '11990', 10),
      },
      features: parseFeatures(
        process.env.BILLING_PLAN_UNLIMITED_FEATURES,
        DEFAULT_UNLIMITED_FEATURES,
      ),
      isActive: true,
      isDefault: false,
      sortOrder: 2,
    },
  ];

  return { plans };
}
