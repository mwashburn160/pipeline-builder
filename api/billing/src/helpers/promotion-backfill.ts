// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Promotion backfill cron (v1.1). Periodically re-scans the eligible base for
 * every active promotion and grants any org that qualifies but hasn't been
 * granted yet — catching grants a transient failure dropped or a campaign that
 * was activated after the org's signup/upgrade event already fired.
 *
 * Idempotent by construction: `batchEvaluatePromotion` grants through the same
 * atomic per-org dedupe guard as the live triggers, so a re-run never double-grants.
 * Leader-locked (single pod runs a cycle) and wrapped in a sysadmin tenant scope
 * like the other multi-org billing crons. No-op unless BILLING_PROMOTIONS_ENABLED.
 */

import { createEnvRedisLock, createLogger, createScheduler, type Scheduler } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config.js';
import { batchEvaluatePromotion, reconcilePromotionSpend } from './promotion-engine.js';
import { Promotion } from '../models/promotion.js';

const logger = createLogger('promotion-backfill');
const LOCK_TTL_MS = 5 * 60 * 1000;
const lockClient = createEnvRedisLock();

async function runBackfillCycle(): Promise<void> {
  const promos = await Promotion.find({ isActive: true });
  for (const promo of promos) {
    try {
      // Heal the advisory spend cache from the ledger first (corrects any recurring
      // re-grant save-failure drift), then catch up missed/late grants.
      await reconcilePromotionSpend(promo);
      const res = await batchEvaluatePromotion(promo);
      if (res.granted > 0) logger.info('Promotion backfill granted', { promotionId: promo._id, ...res });
    } catch (err) {
      logger.error('Promotion backfill cycle errored (fail-soft)', {
        promotionId: promo._id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const scheduler: Scheduler = createScheduler({
  name: 'promotion-backfill',
  intervalMs: config.promotions.backfillIntervalMs,
  run: async () => { await runWithTenantContext({ isSuperAdmin: true }, runBackfillCycle); },
  ...(lockClient ? { lock: { redis: () => lockClient, key: 'promotion-backfill', ttlMs: LOCK_TTL_MS } } : {}),
});

/** Start the backfill cron — a no-op unless promotions are enabled. Safe to call twice. */
export function startPromotionBackfill(): void {
  if (!config.promotions.enabled) {
    logger.debug('Promotions disabled — backfill scheduler not started');
    return;
  }
  logger.info('Starting promotion backfill cron', { intervalMs: config.promotions.backfillIntervalMs });
  scheduler.start();
}
