// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaService } from '@pipeline-builder/api-core';
import { apiCallsQuota, createAuthenticatedWithOrgRoute, rateLimitByOrg } from '@pipeline-builder/api-server';
import type { Express } from 'express';

import { config } from './config.js';
import { createAgentRoutes } from './routes/agent.js';
import { createAskRoutes } from './routes/ask.js';
import { createDraftOutcomeRoutes } from './routes/draft-outcome.js';

/** Dependencies the route factories need. */
export interface AskRouteDeps {
  quotaService: QuotaService;
}

/**
 * Mount every ask-agent route on `app`. Shared by `index.ts` (the running
 * service) and the route-coverage test, so the route table the test checks is
 * the one production serves.
 */
export function mountRoutes(app: Express, { quotaService }: AskRouteDeps): void {
  // -- POST /ask-agent/draft-outcome ---------------------------------------------
  // Mounted FIRST, outside the `apiCallsQuota` meter/check and the per-org Ask
  // rate limit below: reporting what became of a draft is not an Ask, so it must
  // neither spend the org's apiCalls / Ask allowance nor be refused because they
  // ran out. Auth + orgId run only for this path; the router keeps its own gates
  // (requireAskAccess, ai_generation, the org's AI switch, the per-user cap) and
  // the single-use draft id check. Any other /ask-agent request falls through it untouched.
  app.use('/ask-agent/draft-outcome', ...createAuthenticatedWithOrgRoute());
  app.use('/ask-agent', createDraftOutcomeRoutes());

  // -- /ask-agent routes --------------------------------------------------------
  // Auth + orgId at the mount; each handler adds its own capability gate
  // (`requireAskAccess`) and `requireFeature('ai_generation')`.
  // rateLimitByOrg caps LLM spend per tenant (keyed on the verified org, service
  // principals exempt) and must run after auth. Reuses the existing ai_generation
  // entitlement for v1.
  //
  // `apiCallsQuota` meters each 2xx and arms an apiCalls check that runs right
  // after requireAuth (docs/quotas.md): an Ask costs ONE apiCall on top of the
  // aiCalls reservation each handler makes for the LLM spend itself. Mounted
  // ONCE ahead of both routers so no route meters twice.
  app.use('/ask-agent', ...apiCallsQuota(quotaService));
  app.use(
    '/ask-agent',
    ...createAuthenticatedWithOrgRoute(),
    rateLimitByOrg({
      name: 'ask',
      max: config.rateLimits.askPerMin,
      windowMs: 60_000,
      message: 'Too many Ask requests',
    }),
    createAskRoutes(quotaService),
    createAgentRoutes(quotaService),
  );
}
