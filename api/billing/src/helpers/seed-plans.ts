/**
 * @module helpers/seed-plans
 * @description Seed default billing plans on startup if none exist.
 */

import { createLogger } from '@mwashburn160/api-core';
import { Plan } from '../models/plan';

const logger = createLogger('seed-plans');

const DEFAULT_PLANS = [
  {
    _id: 'developer',
    name: 'Developer',
    description: 'Free starter tier for individual developers',
    tier: 'developer' as const,
    prices: { monthly: 0, annual: 0 },
    features: [
      'Up to 100 plugins',
      'Up to 10 pipelines',
      'Unlimited API calls',
      'Community support',
    ],
    isActive: true,
    isDefault: true,
    sortOrder: 0,
  },
  {
    _id: 'pro',
    name: 'Pro',
    description: 'For teams and production workloads',
    tier: 'pro' as const,
    prices: { monthly: 799, annual: 7990 },
    features: [
      'Up to 1,000 plugins',
      'Up to 100 pipelines',
      'Unlimited API calls',
      'Priority support',
      'Advanced analytics',
    ],
    isActive: true,
    isDefault: false,
    sortOrder: 1,
  },
  {
    _id: 'unlimited',
    name: 'Unlimited',
    description: 'No restrictions for enterprise teams',
    tier: 'unlimited' as const,
    prices: { monthly: 1199, annual: 11990 },
    features: [
      'Unlimited plugins',
      'Unlimited pipelines',
      'Unlimited API calls',
      'Dedicated support',
      'Advanced analytics',
      'Custom integrations',
    ],
    isActive: true,
    isDefault: false,
    sortOrder: 2,
  },
];

/**
 * Seed default plans if the plans collection is empty.
 */
export async function seedPlans(): Promise<void> {
  const count = await Plan.countDocuments();
  if (count > 0) {
    logger.info('Plans already seeded', { count });
    return;
  }

  await Plan.insertMany(DEFAULT_PLANS);
  logger.info('Seeded default billing plans', { count: DEFAULT_PLANS.length });
}
