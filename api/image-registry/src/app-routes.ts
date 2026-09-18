// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireAuth } from '@pipeline-builder/api-core';
import type { Express } from 'express';

import { createAdminRoutes } from './routes/admin.js';
import { createImageRoutes } from './routes/images.js';
import { createTokenRoute } from './routes/token.js';

/**
 * Mount every image-registry route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express): void {
  // Docker registry token endpoint — Basic auth (validated inside the route);
  // must NOT go through requireAuth since it accepts platform-JWT-as-password
  // AND `docker login` creds proxied to platform's in-cluster /auth/login. The route itself returns 401 + WWW-Authenticate
  // when creds are missing/invalid.
  app.use('/token', createTokenRoute());

  // Image management API — JWT-authenticated, `registry:read`/`registry:write`
  // gated per-route inside the router.
  app.use('/api/images', requireAuth, createImageRoutes());

  // Admin endpoints — per-namespace storage rollup + manual GC. Same auth
  // + permission gating as /api/images. Periodic pruning of each org's `org-X/`
  // namespace runs in-process (see startGcScheduler in index.ts), not through
  // this route.
  app.use('/api/admin', requireAuth, createAdminRoutes());
}
