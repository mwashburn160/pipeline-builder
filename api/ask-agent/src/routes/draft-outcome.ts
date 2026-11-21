// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, envInt, ErrorCode, errorMessage, getAiDraftStore, getServiceAuthHeader, InternalHttpClient, requireFeature, sendBadRequest, sendError, sendSuccess, validateBody } from '@pipeline-builder/api-core';
import { incCounter, rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
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
 *
 * Each outcome names the `draftId` the generator issued with the draft
 * (pipeline / plugin generate, or an agent proposal): single use, ~1 h, bound
 * to the org, the user and the producing feature (api-core `AiDraftStore`). A
 * reused id is refused with 409, an unknown / forged / expired id or one issued
 * to another user, org or feature with 400, and a draft store that cannot
 * answer with 503 — so an outcome is only ever counted for a real draft, once.
 *
 * Mounted OUTSIDE the per-org Ask rate limit and the `apiCalls` quota
 * (app-routes.ts): reporting what became of a draft is not an Ask, and must
 * neither use up the org's Ask allowance nor be refused because it ran out.
 * Still capped per USER (`ASK_DRAFT_OUTCOME_RATE_LIMIT_PER_MIN`, default 20).
 * The limiter's key and the draft id never leave this service; the forwarded
 * count stays anonymous.
 */
export function createDraftOutcomeRoutes(): Router {
  const router: Router = Router();
  const perUser = rateLimitByOrg({
    name: 'ask-draft-outcome',
    keyBy: 'user',
    max: envInt('ASK_DRAFT_OUTCOME_RATE_LIMIT_PER_MIN', 20, { min: 1 }),
    windowMs: 60_000,
    message: 'Too many draft outcomes',
  });

  router.post('/draft-outcome', requireAskAccess, requireFeature('ai_generation'), perUser, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = validateBody(req, AskDraftOutcomeSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { feature, outcome, draftId } = parsed.value;
    const verdict = await getAiDraftStore().redeem(draftId, { orgId, userId, feature });
    if (verdict !== 'ok') {
      ctx.log('WARN', 'Draft outcome refused', { feature, verdict });
      if (verdict === 'used') return sendError(res, 409, 'This draft\'s outcome was already recorded', ErrorCode.CONFLICT);
      if (verdict === 'unavailable') return sendError(res, 503, 'Draft outcomes cannot be verified right now', ErrorCode.SERVICE_UNAVAILABLE);
      return sendBadRequest(res, 'Unknown or expired draft id');
    }
    incCounter('ai_draft_outcomes_total', { feature, outcome });
    const recorded = await forwardDraftOutcome(orgId, feature, outcome);
    ctx.log('COMPLETED', 'Draft outcome', { feature, outcome, recorded });
    return sendSuccess(res, 200, { recorded });
  }));

  return router;
}
