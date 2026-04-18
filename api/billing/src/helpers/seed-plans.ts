// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@mwashburn160/api-core';
import { Config } from '@mwashburn160/pipeline-core';
import { Plan } from '../models/plan';

const logger = createLogger('seed-plans');

/**
 * Seed default plans if the plans collection is empty.
 * Plan definitions are loaded from Config.get('billing').plans.
 */
export async function seedPlans(): Promise<void> {
  const count = await Plan.countDocuments();
  if (count > 0) {
    logger.info('Plans already seeded', { count });
    return;
  }

  const { plans } = Config.get('billing');

  const documents = plans.map((plan) => ({
    _id: plan.id,
    name: plan.name,
    description: plan.description,
    tier: plan.tier,
    prices: plan.prices,
    features: [...plan.features],
    isActive: plan.isActive,
    isDefault: plan.isDefault,
    sortOrder: plan.sortOrder,
  }));

  await Plan.insertMany(documents);
  logger.info('Seeded default billing plans', { count: documents.length });
}
