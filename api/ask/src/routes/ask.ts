// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  answerHowTo,
  getAvailableProviders,
  streamHowTo,
} from '@pipeline-builder/ai-core';
import {
  audited,
  createLogger,
  decrementQuota,
  errorMessage,
  getServiceAuthHeader,
  handleAIError,
  initSSEStream,
  requireFeature,
  reserveQuota,
  sendBadRequest,
  sendQuotaReserveDenied,
  sendSuccess,
  actorId,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incCounter, observe } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { clientAbortSignal } from '../client-abort.js';
import { AskBodySchema } from '../request-schema.js';
import { getAuditClient } from '../services/audit.js';
import { getDocsIndex } from '../services/docs-index.js';
import { resolveAskModel } from '../services/model.js';

const logger = createLogger('ask');

/**
 * Fire-and-forget audit of a read-only how-to turn — SAFE METADATA ONLY (query length,
 * source count, streamed flag, outcome), never the raw query text.
 */
function auditAskQuery(
  userId: string,
  orgId: string,
  details: { queryLength: number; sources?: number; streamed: boolean; outcome: 'success' | 'failure' },
): void {
  getAuditClient().record({
    action: 'ask.query',
    actorId: actorId({ userId }),
    orgId,
    targetType: 'ask',
    outcome: details.outcome,
    details,
  }, 'ask');
}

/**
 * Emit AI request metrics for a how-to turn (previously the ask paths emitted
 * none, blinding on-call to provider brownouts / spend). `provider` is the
 * requested one or 'default' when the server picks; kept low-cardinality.
 */
function recordAi(route: string, provider: string | undefined, outcome: 'success' | 'error' | 'aborted', startedAt: number): void {
  const providerLabel = provider ?? 'default';
  incCounter('ai_requests_total', { route, provider: providerLabel, outcome });
  if (outcome === 'success') {
    observe('ai_generation_duration_seconds', { route, provider: providerLabel }, (Date.now() - startedAt) / 1000);
  }
}

/**
 * Read-only "Ask" agent routes: grounded how-to answers over the docs corpus.
 *
 * Gated with `requireFeature('ai_generation')` (reused for v1 — same entitlement as
 * pipeline/plugin AI). Each turn reserves one `aiCalls` slot via a service-minted
 * auth header (the quota `/increment` endpoint rejects user principals). The slot is
 * KEPT once the provider has responded (its $ cost was incurred — even if the client
 * then aborts or a later step fails) and REFUNDED only when the provider was never
 * reached. No writes — nothing is mutated here.
 *
 * @param quotaService - Shared quota service
 * @returns Express Router with the ask endpoints
 */
export function createAskRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // -- GET /ask/providers  list configured AI providers ----------------------
  router.get('/providers', requireAskAccess, requireFeature('ai_generation'), withRoute(async ({ res }) => {
    return sendSuccess(res, 200, { providers: getAvailableProviders() });
  }));

  // -- POST /ask  grounded how-to answer (non-streaming) ---------------------
  router.post('/', requireAskAccess, requireFeature('ai_generation'), audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = AskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendBadRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    const { query, provider, model, apiKey, history } = parsed.data;
    const authHeader = getServiceAuthHeader({ serviceName: 'ask', orgId, role: 'member' });

    const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', authHeader);
    if (reservation.exceeded) {
      return sendQuotaReserveDenied(res, 'aiCalls', reservation);
    }

    // True once the provider returned an answer. A failure after that (metrics,
    // audit, response write) keeps the slot; only a pre-answer failure refunds.
    let providerContacted = false;

    const startedAt = Date.now();
    try {
      ctx.log('INFO', 'Ask how-to requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveAskModel(provider, model, apiKey);
      const result = await answerHowTo({ model: aiModel, query, index, history, abortSignal: clientAbortSignal(res) });
      providerContacted = true;
      ctx.log('COMPLETED', 'Ask how-to answered', { sources: result.sources.length });
      recordAi('howto', provider, 'success', startedAt);
      auditAskQuery(userId, orgId, { queryLength: query.length, sources: result.sources.length, streamed: false, outcome: 'success' });
      return sendSuccess(res, 200, result);
    } catch (error) {
      const message = errorMessage(error);
      logger.error('Ask how-to failed', { requestId: ctx.requestId, error: message });
      recordAi('howto', provider, 'error', startedAt);
      auditAskQuery(userId, orgId, { queryLength: query.length, streamed: false, outcome: 'failure' });
      if (!providerContacted) {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      }
      return handleAIError(res, message, 'Failed to answer the question');
    }
  }));

  // -- POST /ask/stream  grounded how-to answer as SSE -----------------------
  router.post('/stream', requireAskAccess, requireFeature('ai_generation'), audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = AskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendBadRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    const { query, provider, model, apiKey, history } = parsed.data;
    const authHeader = getServiceAuthHeader({ serviceName: 'ask', orgId, role: 'member' });

    const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', authHeader);
    if (reservation.exceeded) {
      return sendQuotaReserveDenied(res, 'aiCalls', reservation);
    }
    let reserved = true;
    // True once the provider has started responding (a paid call), so a later
    // failure or abort keeps the slot; a failure before that refunds it.
    let providerContacted = false;

    const startedAt = Date.now();
    try {
      ctx.log('INFO', 'Ask how-to stream requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveAskModel(provider, model, apiKey);

      initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
      const abortSignal = clientAbortSignal(res);
      const { sources, events } = streamHowTo({ model: aiModel, query, index, history, abortSignal });

      // Emit the grounded sources up-front so the UI can show them while tokens arrive.
      if (!abortSignal.aborted) res.write(`data: ${JSON.stringify({ type: 'sources', data: sources })}\n\n`);

      // A provider error throws out of `events` into the catch below.
      for await (const event of events) {
        if (event.type === 'provider-responded') {
          providerContacted = true;
          continue;
        }
        if (abortSignal.aborted) break;
        res.write(`data: ${JSON.stringify({ type: 'token', data: event.text })}\n\n`);
      }

      if (!abortSignal.aborted) {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.write('data: [DONE]\n\n');
        // Completed stream keeps the reserved slot (provider round-trip incurred).
        recordAi('howto-stream', provider, 'success', startedAt);
        auditAskQuery(userId, orgId, { queryLength: query.length, sources: sources.length, streamed: true, outcome: 'success' });
      } else {
        if (!providerContacted) {
          decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
        }
        recordAi('howto-stream', provider, 'aborted', startedAt);
        auditAskQuery(userId, orgId, { queryLength: query.length, streamed: true, outcome: 'failure' });
      }
      res.end();
    } catch (error) {
      const message = errorMessage(error);
      logger.error('Ask how-to stream failed', { requestId: ctx.requestId, error: message });
      recordAi('howto-stream', provider, 'error', startedAt);
      auditAskQuery(userId, orgId, { queryLength: query.length, streamed: true, outcome: 'failure' });
      if (reserved && !providerContacted) {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      }
      handleAIError(res, message, 'Failed to answer the question');
    }
  }));

  return router;
}
