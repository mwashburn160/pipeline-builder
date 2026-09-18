// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, mongoSanitize, wireServiceSecurity, createEnvRedisDurableEventBus } from '@pipeline-builder/api-core';
import type { EventSubscription } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, mongoHealthCheck, connectMongo } from '@pipeline-builder/api-server';
import mongoose from 'mongoose';

import { mountRoutes } from './app-routes.js';
import { config } from './config.js';
import { setEntitlementSyncBus, startEntitlementSyncConsumer } from './helpers/billing-helpers.js';
import { startMarketplaceMetering, stopMarketplaceMetering } from './helpers/marketplace-metering.js';
import { startPromotionBackfill } from './helpers/promotion-backfill.js';
import { seedPlans } from './helpers/seed-plans.js';
import { startSubscriptionLifecycleChecker, stopSubscriptionLifecycleChecker } from './helpers/subscription-lifecycle.js';
import { validateProviderConfig } from './helpers/validate-provider-config.js';
import { getAuditClient } from './services/audit.js';

const logger = createLogger('billing');

// Forward denied (non-GET) requests to the shared authz.denied audit sink.
// Registered unconditionally — harmless in disabled mode (no gated routes fire).
wireServiceSecurity('billing', getAuditClient);

// -- Express app ---------------------------------------------------------------

const { app, sseManager } = createApp({
  // Only check MongoDB when billing is enabled — disabled mode never connects
  checkDependencies: config.enabled ? mongoHealthCheck(mongoose.connection) : undefined,
  // Warm Mongo on /warmup when billing is active.
  warmupHooks: config.enabled
    ? [async () => { await mongoose.connection.db?.admin().ping(); }]
    : [],
  // Stripe webhook HMAC is computed over the EXACT raw bytes — keep the global JSON
  // parser off this path so the per-path `express.raw()` (below) can read them.
  // Without this, signature verification 400s on every real delivery.
  jsonBodyExclude: ['/billing/stripe/webhook'],
});

// Mongo operator-injection guard — strips `$`-prefixed keys + dot-walks from
// incoming JSON. Billing is Mongo-backed so this matters here. Runs BEFORE the
// request-context middleware (mirrors quota's index) so any structured logging
// triggered by the sanitizer or downstream middleware reading req.body/req.query
// sees the already-sanitised payload, not the raw operator-laden one.
app.use(mongoSanitize());
app.use(attachRequestContext(sseManager));

// Routes (including the always-on /billing/config probe and, when billing is
// disabled, the 503 catch-all) — see app-routes.ts, shared with the
// route-coverage test so the checked table is the one production serves.
mountRoutes(app);

if (config.enabled) {

  // Handle to the durable entitlement-sync consumer so it can be stopped on shutdown.
  let entitlementSyncSub: EventSubscription | null = null;

  runServer(app, {
    name: 'Billing Service',
    port: config.port,
    onBeforeStart: async () => {
      validateProviderConfig();
      await connectMongo(mongoose, config.mongodb.uri);
      await seedPlans();
      // Durable entitlement-sync backbone: a failed sync publishes a retry event
      // that this consumer re-drives at-least-once (replaces the old polling
      // reconcileFailedEntitlementSyncs). Null when Redis isn't configured — the
      // sync then still runs inline, just without durable retry.
      const entitlementBus = createEnvRedisDurableEventBus();
      setEntitlementSyncBus(entitlementBus);
      if (entitlementBus) entitlementSyncSub = startEntitlementSyncConsumer(entitlementBus);
      startSubscriptionLifecycleChecker();
      startMarketplaceMetering();
      startPromotionBackfill();
    },
    testDatabase: async () => mongoose.connection.readyState === 1,
    closeDatabase: async () => {
      stopSubscriptionLifecycleChecker();
      stopMarketplaceMetering();
      await entitlementSyncSub?.stop();
      setEntitlementSyncBus(null);
      await mongoose.connection.close(false);
    },
  });
} else {
  logger.info('Billing is disabled (BILLING_ENABLED=false)');

  runServer(app, {
    name: 'Billing Service (disabled)',
    port: config.port,
  });
}

export { app };
