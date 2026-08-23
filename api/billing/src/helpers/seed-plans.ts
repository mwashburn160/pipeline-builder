// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { Plan } from '../models/plan.js';
import { invalidatePlanCache } from '../routes/read-plans.js';

const logger = createLogger('seed-plans');

/**
 * Reconcile the plan catalog in Mongo with the env-driven config on every boot.
 *
 * The catalog (names, descriptions, prices, features, ordering) is defined
 * entirely by `Config.get('billing').plans`, which reads from `BILLING_PLAN_*`
 * environment variables (see billing-config.ts). There is no admin write path
 * for plans — the DB is purely a seeded, cacheable projection of that config —
 * so this upserts every configured plan by id, letting an env price change
 * (e.g. `BILLING_PLAN_ENTERPRISE_MONTHLY`) actually propagate to the signup /
 * billing screens instead of being frozen at whatever was first inserted.
 *
 * Any plan row NOT in the current config is deactivated (`isActive:false`)
 * rather than deleted, so a removed tier stops being offered without orphaning
 * subscriptions that still reference its id.
 */
export async function seedPlans(): Promise<void> {
  const { plans } = Config.get('billing');

  const ops = plans.map((plan) => ({
    updateOne: {
      filter: { _id: plan.id },
      update: {
        $set: {
          name: plan.name,
          description: plan.description,
          tier: plan.tier,
          prices: plan.prices,
          features: [...plan.features],
          isActive: plan.isActive,
          isDefault: plan.isDefault,
          sortOrder: plan.sortOrder,
        },
      },
      upsert: true,
    },
  }));

  const result = await Plan.bulkWrite(ops);

  // Retire any plan not in the current config (a tier removed from config) so it
  // stops being served, without hard-deleting rows subscriptions may reference.
  const configIds = plans.map((p) => p.id);
  const retired = await Plan.updateMany(
    { _id: { $nin: configIds }, isActive: true },
    { $set: { isActive: false } },
  );

  // The read routes cache plan projections for hours (Redis, survives restarts);
  // drop them so the reconciled prices/features show up immediately.
  await invalidatePlanCache();

  logger.info('Reconciled billing plans from config', {
    upserted: result.upsertedCount,
    modified: result.modifiedCount,
    retired: retired.modifiedCount,
    total: plans.length,
  });
}
