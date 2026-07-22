// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, ErrorCode, mongoSanitize, setAuthzDenialAuditor, setTokenRevocationStore, createEnvRedisTokenRevocationStore } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, mongoHealthCheck, connectMongo } from '@pipeline-builder/api-server';
import express from 'express';
import mongoose from 'mongoose';

import { config } from './config.js';
import { startMarketplaceMetering, stopMarketplaceMetering } from './helpers/marketplace-metering.js';
import { seedPlans } from './helpers/seed-plans.js';
import { startSubscriptionLifecycleChecker, stopSubscriptionLifecycleChecker } from './helpers/subscription-lifecycle.js';
import { createAddonRoutes } from './routes/addons.js';
import { createAdminSubscriptionRoutes } from './routes/admin-subscriptions.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createReadPlanRoutes } from './routes/read-plans.js';
import { createStripeWebhookRoutes } from './routes/stripe-webhook.js';
import { createSubscriptionRoutes } from './routes/subscriptions.js';
import { createUsageRoutes } from './routes/usage.js';
import { getAuditClient } from './services/audit.js';

const logger = createLogger('billing');

// -- Failed-authorization auditor (#5) ----------------------------------------
// Forward denials from the shared requirePermission / requireSystemAdmin gate to
// platform's audit ingest as `authz.denied`, best-effort (the gate try/catches).
// Registered unconditionally — harmless in disabled mode (no gated routes fire).
setAuthzDenialAuditor((info) => getAuditClient().record({
  action: 'authz.denied',
  actorId: info.actorId ?? 'anonymous',
  actorEmail: info.actorEmail,
  orgId: info.orgId,
  outcome: 'failure',
  details: { method: info.method, path: info.path, required: info.required },
}, 'billing'));

// Reject tokens whose tokenVersion is behind the platform-published value once
// Redis is configured; fail-open (no-op) otherwise — falls back to token expiry.
setTokenRevocationStore(createEnvRedisTokenRevocationStore());

// -- Express app ---------------------------------------------------------------

const { app, sseManager } = createApp({
  // Only check MongoDB when billing is enabled — disabled mode never connects
  checkDependencies: config.enabled ? mongoHealthCheck(mongoose.connection) : undefined,
  // Warm Mongo on /warmup when billing is active.
  warmupHooks: config.enabled
    ? [async () => { await mongoose.connection.db?.admin().ping(); }]
    : [],
});

// Mongo operator-injection guard — strips `$`-prefixed keys + dot-walks from
// incoming JSON. Billing is Mongo-backed so this matters here. Runs BEFORE the
// request-context middleware (mirrors quota's index) so any structured logging
// triggered by the sanitizer or downstream middleware reading req.body/req.query
// sees the already-sanitised payload, not the raw operator-laden one.
app.use(mongoSanitize());
app.use(attachRequestContext(sseManager));

if (config.enabled) {

  app.use('/billing', createReadPlanRoutes());
  app.use('/billing', createSubscriptionRoutes());
  app.use('/billing', createAddonRoutes());
  app.use('/billing', createUsageRoutes());
  app.use('/billing', createAdminSubscriptionRoutes());

  // SNS may send text/plain — add text body parser for the marketplace SNS webhook
  app.use('/billing/marketplace/sns', express.text({ type: 'text/plain' }));
  app.use('/billing', createMarketplaceRoutes());

  // Stripe requires raw body for webhook signature verification
  app.use('/billing/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/billing', createStripeWebhookRoutes());

  runServer(app, {
    name: 'Billing Service',
    port: config.port,
    onBeforeStart: async () => {
      await connectMongo(mongoose, config.mongodb.uri);
      await seedPlans();
      startSubscriptionLifecycleChecker();
      startMarketplaceMetering();
    },
    testDatabase: async () => mongoose.connection.readyState === 1,
    closeDatabase: async () => {
      stopSubscriptionLifecycleChecker();
      stopMarketplaceMetering();
      await mongoose.connection.close(false);
    },
  });
} else {
  logger.info('Billing is disabled (BILLING_ENABLED=false)');

  // Return 503 for all billing routes when disabled
  app.use('/billing', (_req, res) => {
    sendError(res, 503, 'Billing is disabled', ErrorCode.SERVICE_UNAVAILABLE);
  });

  runServer(app, {
    name: 'Billing Service (disabled)',
    port: config.port,
  });
}

export { app };
