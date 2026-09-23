// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt } from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, rateLimitByOrg } from '@pipeline-builder/api-server';
import type { Express } from 'express';

import { createAgentRoutes } from './routes/agent.js';
import { createAskRoutes } from './routes/ask.js';

/** Dependencies the route factories need. */
export interface AskRouteDeps {
  quotaService: QuotaService;
}

/**
 * Mount every ask-service route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express, { quotaService }: AskRouteDeps): void {
  // -- /ask routes --------------------------------------------------------------
  // Auth + orgId at the mount; each handler adds its own capability gate
  // (`requireAskAccess`) and `requireFeature('ai_generation')`.
  // rateLimitByOrg caps LLM spend per tenant (keyed on the verified org, service
  // principals exempt) and must run after auth. Reuses the existing ai_generation
  // entitlement for v1.
  app.use(
    '/ask',
    ...createAuthenticatedWithOrgRoute(),
    rateLimitByOrg({
      name: 'ask',
      max: envInt('ASK_RATE_LIMIT_PER_MIN', 30, { min: 1 }),
      windowMs: 60_000,
      message: 'Too many Ask requests',
    }),
    createAskRoutes(quotaService),
    createAgentRoutes(quotaService),
  );
}
