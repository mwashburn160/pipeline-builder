// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, getServiceAuthHeader, InternalHttpClient, requireFeature, sendBadRequest, sendSuccess, validateBody } from '@pipeline-builder/api-core';
import { incCounter, withRoute } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { AskDraftOutcomeSchema } from '../request-schema.js';

const logger = createLogger('ask-draft-outcome');

/** Timeout for the one quota write (the user's flow never waits on it for long). */
const FORWARD_TIMEOUT_MS = 3000;

/**
 * Count one draft outcome in the quota service (`POST /quotas/:orgId/increment`
 * with `draftOutcome` — the same internal route the AI usage reports ride, so no
 * new internal route or mesh rule). Sent on ASK-AGENT'S OWN service identity:
 * that route admits only named internal services, never a user token. The body
 * is exactly the org's feature and outcome — no user id, no prompt, no content.
 * Never throws: a lost count is logged and counted, and the caller's flow goes on.
 */
async function forwardDraftOutcome(orgId: string, feature: string, outcome: string): Promise<boolean> {
  const { quotaHost, quotaPort } = Config.get('server').services;
  const http = new InternalHttpClient({ host: quotaHost, port: quotaPort, timeout: FORWARD_TIMEOUT_MS });
  try {
    const res = await http.post(
      `/quotas/${encodeURIComponent(orgId)}/increment`,
      { quotaType: 'aiCalls', draftOutcome: { feature, outcome } },
      {
        headers: { 'Authorization': getServiceAuthHeader({ serviceName: 'ask-agent', orgId, role: 'member' }), 'x-org-id': orgId },
        maxRetries: 0,
        maxRateLimitRetries: 0,
      },
    );
    if (res && res.statusCode === 200) return true;
    logger.warn('Draft outcome not recorded', { orgId, statusCode: res?.statusCode });
    incCounter('ai_draft_outcome_forward_failures_total', { reason: 'non-ok' });
  } catch (err) {
    logger.warn('Draft outcome not recorded', { orgId, error: errorMessage(err) });
    incCounter('ai_draft_outcome_forward_failures_total', { reason: 'exception' });
  }
  return false;
}

/**
 * `POST /ask-agent/draft-outcome` — what the user did with one AI-generated
 * draft: `accepted`, `edited_accepted` or `discarded`, for one draft-producing
 * feature (`agent` | `pipeline-generate` | `plugin-generate`). Called by the
 * dashboard's AI generation tabs when a draft is created as-is, created after
 * edits, or closed / replaced unused. It feeds the acceptance rate of the AI
 * assistant usage report (`GET /quotas/:orgId/ai-usage`).
 *
 * Same gates as every Ask route (`requireAskAccess` + `ai_generation`: an
 * outcome only follows a generation those gates admitted). NOT audited, on
 * purpose: an audit row carries its actor, and this signal must never be
 * attributable to a person — it is counted per org and feature, nothing else.
 */
export function createDraftOutcomeRoutes(): Router {
  const router: Router = Router();

  router.post('/draft-outcome', requireAskAccess, requireFeature('ai_generation'), withRoute(async ({ req, res, ctx, orgId }) => {
    const parsed = validateBody(req, AskDraftOutcomeSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { feature, outcome } = parsed.value;
    incCounter('ai_draft_outcomes_total', { feature, outcome });
    const recorded = await forwardDraftOutcome(orgId, feature, outcome);
    ctx.log('COMPLETED', 'Draft outcome', { feature, outcome, recorded });
    return sendSuccess(res, 200, { recorded });
  }));

  return router;
}
