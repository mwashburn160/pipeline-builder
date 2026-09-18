// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Express } from 'express';

import { createReadQuotaRoutes } from './routes/read-quotas.js';
import { createUpdateQuotaRoutes } from './routes/update-quota.js';

/**
 * Mount every quota-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 *
 * Both routers own their full per-route middleware chains (requireAuth +
 * authorizeOrg + the permission gate), so nothing is layered at the mount —
 * mount-level guards would leak onto every sibling path under `/quotas`.
 * Read routes mount first: their literal paths (`/all`, `/at-risk`) must be
 * claimed before any `/:orgId` pattern.
 */
export function mountRoutes(app: Express): void {
  app.use('/quotas', createReadQuotaRoutes());
  app.use('/quotas', createUpdateQuotaRoutes());
}
