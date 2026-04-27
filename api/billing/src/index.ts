// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, ErrorCode } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, mongoHealthCheck } from '@pipeline-builder/api-server';
import express from 'express';
import mongoose from 'mongoose';

import { config } from './config';
import { connectDatabase } from './helpers/database';
import { seedPlans } from './helpers/seed-plans';
import { startSubscriptionLifecycleChecker, stopSubscriptionLifecycleChecker } from './helpers/subscription-lifecycle';
import { createAdminSubscriptionRoutes } from './routes/admin-subscriptions';
import { createMarketplaceRoutes } from './routes/marketplace';
import { createReadPlanRoutes } from './routes/read-plans';
import { createStripeWebhookRoutes } from './routes/stripe-webhook';
import { createSubscriptionRoutes } from './routes/subscriptions';

const logger = createLogger('billing');

// -- Express app ---------------------------------------------------------------

const { app, sseManager } = createApp({
  // Only check MongoDB when billing is enabled — disabled mode never connects
  checkDependencies: config.enabled ? mongoHealthCheck(mongoose.connection) : undefined,
  // Warm Mongo on /warmup when billing is active.
  warmupHooks: config.enabled
    ? [async () => { await mongoose.connection.db?.admin().ping(); }]
    : [],
});

app.use(attachRequestContext(sseManager));

if (config.enabled) {

  app.use('/billing', createReadPlanRoutes());
  app.use('/billing', createSubscriptionRoutes());
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
      await connectDatabase(config.mongodb.uri);
      await seedPlans();
      startSubscriptionLifecycleChecker();
    },
    testDatabase: async () => mongoose.connection.readyState === 1,
    closeDatabase: async () => {
      stopSubscriptionLifecycleChecker();
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
