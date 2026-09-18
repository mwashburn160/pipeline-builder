// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, ErrorCode } from '@pipeline-builder/api-core';
import express, { type Express } from 'express';

import { config } from './config.js';
import { createAddonRoutes } from './routes/addons.js';
import { createAdminSubscriptionRoutes } from './routes/admin-subscriptions.js';
import { createBillingSummaryRoutes } from './routes/billing-summary.js';
import { createDiscountRoutes } from './routes/discounts.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createPromotionRoutes } from './routes/promotions.js';
import { createReadPlanRoutes } from './routes/read-plans.js';
import { createStripeWebhookRoutes } from './routes/stripe-webhook.js';
import { createSubscriptionRoutes } from './routes/subscriptions.js';
import { createUsageRoutes } from './routes/usage.js';

/**
 * Mount every billing-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 *
 * Billing is deployment-optional: with `BILLING_ENABLED=false` none of the
 * `/billing/*` routers are registered and a single catch-all answers 503. That
 * conditional lives HERE so both callers build the identical shape. Mount ORDER
 * is load-bearing (see billing-router-mount.test.ts) — don't reorder.
 */
export function mountRoutes(app: Express): void {
  // Deployment-config probe — registered UNCONDITIONALLY so it answers in BOTH
  // enabled and disabled mode (the gated `/billing/*` routes below only exist when
  // enabled). The frontend reads this to auto-hide the Billing nav when billing is
  // off, instead of showing a link that dead-ends at a 503. Exposes only the
  // enabled flag + provider name — no secrets, no DB access, so it's safe with no
  // auth (any authed caller reaching the gateway can read it).
  app.get('/billing/config', (_req, res) => {
    sendSuccess(res, 200, { enabled: config.enabled, provider: config.billingProvider });
  });

  if (!config.enabled) {
    // Return 503 for all billing routes when disabled
    app.use('/billing', (_req, res) => {
      sendError(res, 503, 'Billing is disabled', ErrorCode.SERVICE_UNAVAILABLE);
    });
    return;
  }

  app.use('/billing', createReadPlanRoutes());
  app.use('/billing', createSubscriptionRoutes());
  app.use('/billing', createAddonRoutes());
  app.use('/billing', createDiscountRoutes());
  app.use('/billing', createPromotionRoutes());
  app.use('/billing', createBillingSummaryRoutes());
  app.use('/billing', createUsageRoutes());
  app.use('/billing', createAdminSubscriptionRoutes());

  // SNS may send text/plain — add text body parser for the marketplace SNS webhook
  app.use('/billing/marketplace/sns', express.text({ type: 'text/plain' }));
  app.use('/billing', createMarketplaceRoutes());

  // Stripe requires raw body for webhook signature verification
  app.use('/billing/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/billing', createStripeWebhookRoutes());
}
