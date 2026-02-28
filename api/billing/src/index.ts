/**
 * @module billing
 * @description Billing microservice.
 *
 * Routes mounted under /billing:
 *
 *   GET    /billing/plans                        — list all active plans (public)
 *   GET    /billing/plans/:planId                — get single plan details (public)
 *   GET    /billing/subscriptions                — get current org subscription
 *   POST   /billing/subscriptions                — create subscription (pick plan + interval)
 *   PUT    /billing/subscriptions/:id            — change plan or interval
 *   POST   /billing/subscriptions/:id/cancel     — cancel at period end
 *   POST   /billing/subscriptions/:id/reactivate — reactivate canceled subscription
 *   GET    /billing/admin/subscriptions          — list all subscriptions (admin)
 *   PUT    /billing/admin/subscriptions/:id      — admin override subscription
 *   GET    /billing/admin/events                 — list billing events (admin)
 *   POST   /billing/marketplace/resolve          — AWS Marketplace registration redirect
 *   POST   /billing/marketplace/sns              — AWS Marketplace SNS webhook
 *   GET    /billing/marketplace/entitlements      — check marketplace entitlements
 *   POST   /billing/stripe/webhook               — Stripe webhook events
 *
 * Set BILLING_ENABLED=false to run the service in disabled mode (health check only, 503 on all billing routes).
 */

import { createHealthRouter, createLogger, sendError } from '@mwashburn160/api-core';
import { createApp, runServer } from '@mwashburn160/api-server';
import express from 'express';
import mongoose from 'mongoose';

import { config } from './config';
import { connectDatabase } from './helpers/database';
import { seedPlans } from './helpers/seed-plans';
import { createAdminSubscriptionRoutes } from './routes/admin-subscriptions';
import { createMarketplaceRoutes } from './routes/marketplace';
import { createReadPlanRoutes } from './routes/read-plans';
import { createStripeWebhookRoutes } from './routes/stripe-webhook';
import { createSubscriptionRoutes } from './routes/subscriptions';

const logger = createLogger('billing');

// -- Express app ---------------------------------------------------------------

const { app } = createApp({ skipDefaultHealthCheck: true });

if (config.enabled) {
  app.use(createHealthRouter({
    serviceName: 'billing',
    checkDependencies: async () => ({
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    }),
  }));

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
    },
    testDatabase: async () => mongoose.connection.readyState === 1,
    closeDatabase: async () => { await mongoose.connection.close(false); },
  });
} else {
  logger.info('Billing is disabled (BILLING_ENABLED=false)');

  app.use(createHealthRouter({ serviceName: 'billing' }));

  // Return 503 for all billing routes when disabled
  app.use('/billing', (_req, res) => {
    sendError(res, 503, 'Billing is disabled');
  });

  runServer(app, {
    name: 'Billing Service (disabled)',
    port: config.port,
  });
}

export { app };
