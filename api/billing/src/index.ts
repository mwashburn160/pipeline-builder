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
import adminRoutes from './routes/admin';
import marketplaceRoutes from './routes/marketplace';
import planRoutes from './routes/plans';
import subscriptionRoutes from './routes/subscriptions';

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

  app.use('/billing', planRoutes);
  app.use('/billing', subscriptionRoutes);
  app.use('/billing', adminRoutes);

  // SNS may send text/plain — add text body parser for the marketplace SNS webhook
  app.use('/billing/marketplace/sns', express.text({ type: 'text/plain' }));
  app.use('/billing', marketplaceRoutes);

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
