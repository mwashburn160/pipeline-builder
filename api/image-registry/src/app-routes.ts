// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth, type QuotaService } from '@pipeline-builder/api-core';
import { apiCallsQuota } from '@pipeline-builder/api-server';
import type { Express } from 'express';

import { createAdminRoutes } from './routes/admin.js';
import { createImageRoutes } from './routes/images.js';
import { createInternalRoutes } from './routes/internal.js';
import { createTokenRoute } from './routes/token.js';

/** Dependencies the route factories need. */
export interface ImageRegistryRouteDeps {
  /** Quota service client — meters and checks apiCalls on the management API. */
  quotaService: QuotaService;
}

/**
 * Mount every image-registry route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express, { quotaService }: ImageRegistryRouteDeps): void {
  // ── apiCalls quota ─────────────────────────────────────────────────────────
  // Mounted ONCE per prefix, ahead of the router, so no route meters twice:
  // meter once per 2xx + a check deferred to requireAuth. Both management
  // prefixes are covered. Most of their routes are system-org-only reads (out of
  // the per-tenant rule by construction); the destructive ones — the image and
  // manifest DELETEs and the manual GC, all `registry:purge` — are held by the
  // superadmin flag alone, but that is still an authenticated API call made
  // under an org, so it is metered like any other rather than carved out.
  //
  // Not mounted: /token is the Docker token handshake (Basic auth inside the
  // route, never requireAuth — a pull/push is not an API call and the storage
  // push gate is its quota), and /internal is service-principal traffic, which
  // neither half ever bills.
  app.use('/api/images', ...apiCallsQuota(quotaService));
  app.use('/api/admin', ...apiCallsQuota(quotaService));

  // Docker registry token endpoint — Basic auth (validated inside the route);
  // must NOT go through requireAuth since it accepts platform-JWT-as-password
  // AND `docker login` creds proxied to platform's in-cluster /auth/login. The route itself returns 401 + WWW-Authenticate
  // when creds are missing/invalid.
  app.use('/token', createTokenRoute());

  // Image management API — JWT-authenticated, `registry:read`/`:write`/`:purge`
  // gated per-route inside the router, by blast radius.
  app.use('/api/images', requireAuth, createImageRoutes());

  // Admin endpoints — per-namespace storage rollup + manual GC. Same auth
  // + permission gating as /api/images. Periodic pruning of each org's `org-X/`
  // namespace runs in-process (see startGcScheduler in index.ts), not through
  // this route.
  app.use('/api/admin', requireAuth, createAdminRoutes());

  // Service-to-service routes (plugin → plugin-image signing and the public
  // namespace; quota → an org's storage reading). Each route carries its own
  // `requireInternalService` caller allow-list.
  app.use('/internal', requireAuth, createInternalRoutes());
}
