// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every ops-center route, mounted on `app`. Shared by `index.ts` (the
 * running service) and the route-coverage test, so the route table the test
 * checks is the one production serves.
 *
 * External paths are UNCHANGED by the split out of platform: nginx proxies
 * `/api/observability/*` and `/api/dashboards*` here (stripping `/api`), so the
 * browser and the CLI call exactly what they called before.
 *
 * Mount ORDER is load-bearing: the raw body parser for the PagerDuty ack must
 * precede everything under `/observability`, and the alert-webhook bucket must
 * precede the tenant prefix so the relay never shares a tenant budget.
 */

import express, { type Express, type RequestHandler } from 'express';

import { alertWebhookLimiter } from './middleware/limiters.js';
import { opsApiCallsQuota } from './middleware/quota.js';
import clientVitalsRoutes, { CLIENT_VITALS_PATH } from './routes/client-vitals.js';
import dashboardRoutes from './routes/dashboards.js';
import { createInternalOrgPurgeRoutes, OPS_INTERNAL_MOUNT } from './routes/internal-org-purge.js';
import observabilityRoutes from './routes/observability.js';

/** The Alertmanager relay webhook (its own burst bucket — see middleware/limiters.ts). */
export const ALERT_WEBHOOK_PATH = '/observability/alert-webhook';

/**
 * The PagerDuty inbound acknowledgement webhook. PagerDuty signs the exact
 * bytes it sent, and `JSON.stringify(req.body)` after a parse produces
 * different ones — so this path is excluded from the JSON parser (`index.ts`
 * passes it as `jsonBodyExclude`) and gets the RAW body here instead.
 */
export const ONCALL_ACK_PATH = '/observability/oncall-ack';

/** Route dependencies (none yet beyond module singletons; kept for parity with siblings). */
export interface OpsRouteDeps {
  /** Override the apiCalls meter/check chain (tests). */
  apiCallsQuota?: RequestHandler[];
}

export function mountRoutes(app: Express, deps: OpsRouteDeps = {}): void {
  const quota = deps.apiCallsQuota ?? opsApiCallsQuota;
  app.use(ONCALL_ACK_PATH, express.raw({ type: 'application/json', limit: '1mb' }));
  app.use(ALERT_WEBHOOK_PATH, alertWebhookLimiter);
  // Browser telemetry, AHEAD of the tenant prefix so it never meters/checks
  // apiCalls (routes/client-vitals.ts says why).
  app.use(CLIENT_VITALS_PATH, clientVitalsRoutes);
  // `apiCalls` meters + gates the tenant surface (checked by each route's
  // requireAuth); service principals and the unauthenticated machine webhooks
  // are skipped by the middleware itself (docs/quotas.md).
  app.use('/observability', ...quota, observabilityRoutes);
  app.use('/dashboards', ...quota, dashboardRoutes);
  // platform's cascade outbox only (requireInternalService). Not proxied by nginx.
  app.use(OPS_INTERNAL_MOUNT, createInternalOrgPurgeRoutes());
}
