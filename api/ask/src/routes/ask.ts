// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  answerHowTo,
  getAvailableProviders,
  streamHowTo,
} from '@pipeline-builder/ai-core';
import {
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
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute, incCounter, observe } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { AskBodySchema } from '../request-schema.js';
import { getAuditClient } from '../services/audit.js';
import { getDocsIndex } from '../services/docs-index.js';
import { resolveAskModel } from '../services/model.js';

const logger = createLogger('ask');

/** An AbortSignal that fires when the client disconnects — cancels the provider call. */
function requestAbortSignal(req: { on(event: 'close', cb: () => void): void }): AbortSignal {
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  return controller.signal;
}

/**
 * Fire-and-forget audit of a read-only how-to turn — SAFE METADATA ONLY (query length,
 * source count, streamed flag, outcome), never the raw query text.
 */
function auditAskQuery(
  req: { user?: { sub?: string } },
  orgId: string,
  details: { queryLength: number; sources?: number; streamed: boolean; outcome: 'success' | 'failure' },
): void {
  getAuditClient().record({
    action: 'ask.query',
    actorId: req.user?.sub ?? 'system',
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
 * auth header (the quota `/increment` endpoint rejects user principals); an aborted
 * stream refunds it, a completed one keeps it (the provider round-trip's $ cost was
 * already incurred). No writes — nothing is mutated here.
 *
 * @param quotaService - Shared quota service
 * @returns Express Router with the ask endpoints
 */
export function createAskRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // -- GET /ask/providers  list configured AI providers ----------------------
  router.get('/providers', requireFeature('ai_generation'), withRoute(async ({ res }) => {
    return sendSuccess(res, 200, { providers: getAvailableProviders() });
  }));

  // -- POST /ask  grounded how-to answer (non-streaming) ---------------------
  router.post('/', requireFeature('ai_generation'), withRoute(async ({ req, res, ctx, orgId }) => {
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

    const startedAt = Date.now();
    try {
      ctx.log('INFO', 'Ask how-to requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveAskModel(provider, model, apiKey);
      const result = await answerHowTo({ model: aiModel, query, index, history, abortSignal: requestAbortSignal(req) });
      ctx.log('COMPLETED', 'Ask how-to answered', { sources: result.sources.length });
      recordAi('howto', provider, 'success', startedAt);
      auditAskQuery(req, orgId, { queryLength: query.length, sources: result.sources.length, streamed: false, outcome: 'success' });
      return sendSuccess(res, 200, result);
    } catch (error) {
      const message = errorMessage(error);
      logger.error('Ask how-to failed', { requestId: ctx.requestId, error: message });
      recordAi('howto', provider, 'error', startedAt);
      auditAskQuery(req, orgId, { queryLength: query.length, streamed: false, outcome: 'failure' });
      decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      return handleAIError(res, message, 'Failed to answer the question');
    }
  }));

  // -- POST /ask/stream  grounded how-to answer as SSE -----------------------
  router.post('/stream', requireFeature('ai_generation'), withRoute(async ({ req, res, ctx, orgId }) => {
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
    // See agent.ts: true once the provider has actually streamed something, so
    // a post-response failure doesn't refund a call we already paid for.
    let providerContacted = false;

    const startedAt = Date.now();
    try {
      ctx.log('INFO', 'Ask how-to stream requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveAskModel(provider, model, apiKey);

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
      const { sources, textStream } = streamHowTo({ model: aiModel, query, index, history, abortSignal: requestAbortSignal(req) });

      // Emit the grounded sources up-front so the UI can show them while tokens arrive.
      if (!sse.aborted()) res.write(`data: ${JSON.stringify({ type: 'sources', data: sources })}\n\n`);

      for await (const token of textStream) {
        providerContacted = true;
        if (sse.aborted()) break;
        res.write(`data: ${JSON.stringify({ type: 'token', data: token })}\n\n`);
      }

      if (!sse.aborted()) {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.write('data: [DONE]\n\n');
        // Completed stream keeps the reserved slot (provider round-trip incurred).
        recordAi('howto-stream', provider, 'success', startedAt);
        auditAskQuery(req, orgId, { queryLength: query.length, sources: sources.length, streamed: true, outcome: 'success' });
      } else {
        if (!providerContacted) {
          decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
        }
        recordAi('howto-stream', provider, 'aborted', startedAt);
        auditAskQuery(req, orgId, { queryLength: query.length, streamed: true, outcome: 'failure' });
      }
      res.end();
    } catch (error) {
      const message = errorMessage(error);
      logger.error('Ask how-to stream failed', { requestId: ctx.requestId, error: message });
      recordAi('howto-stream', provider, 'error', startedAt);
      auditAskQuery(req, orgId, { queryLength: query.length, streamed: true, outcome: 'failure' });
      if (reserved && !providerContacted) {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      }
      handleAIError(res, message, 'Failed to answer the question');
    }
  }));

  return router;
}
