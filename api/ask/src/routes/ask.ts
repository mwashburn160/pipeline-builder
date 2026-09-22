// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getAvailableProviders,
  resolveModelSelection,
  streamHowTo,
} from '@pipeline-builder/ai-core';
import {
  audited,
  clientAbortSignal,
  createLogger,
  errorMessage,
  handleAIError,
  initSSEStream,
  requireFeature,
  sendBadRequest,
  sendSuccess,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withQuotaReservation, withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { AskBodySchema } from '../request-schema.js';
import { recordAi } from '../services/ai-metrics.js';
import { getDocsIndex } from '../services/docs-index.js';
import { ASK_MAX_OUTPUT_TOKENS } from '../services/model.js';

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
  recordAudit({
    action: 'ask.query',
    actorId: actorId({ userId }),
    orgId,
    targetType: 'ask',
    outcome: details.outcome,
    details,
  });
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
    const startedAt = Date.now();
    // The provider STARTED responding (a paid call) marks the slot consumed — the
    // same `provider-responded` signal the stream path uses. The answer is
    // collected from the stream rather than a one-shot generate, because a
    // one-shot call gives no such signal: a provider that responded and THEN
    // failed (mid-body error, client abort) looked "never contacted" and was
    // refunded for free.
    await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', serviceName: 'ask', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
      ctx.log('INFO', 'Ask how-to requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveModelSelection({ provider, model, apiKey }).model;
      const { sources, events } = streamHowTo({ model: aiModel, query, index, history, abortSignal: clientAbortSignal(res), maxOutputTokens: ASK_MAX_OUTPUT_TOKENS });
      let text = '';
      for await (const event of events) {
        if (event.type === 'provider-responded') slot.markConsumed();
        else text += event.text;
      }
      const result = { text, sources };
      ctx.log('COMPLETED', 'Ask how-to answered', { sources: result.sources.length });
      recordAi('howto', provider, 'success', startedAt);
      auditAskQuery(userId, orgId, { queryLength: query.length, sources: result.sources.length, streamed: false, outcome: 'success' });
      sendSuccess(res, 200, result);
    }, (error) => {
      const message = errorMessage(error);
      logger.error('Ask how-to failed', { requestId: ctx.requestId, error: message });
      recordAi('howto', provider, 'error', startedAt);
      auditAskQuery(userId, orgId, { queryLength: query.length, streamed: false, outcome: 'failure' });
      handleAIError(res, message, 'Failed to answer the question');
    });
  }));

  // -- POST /ask/stream  grounded how-to answer as SSE -----------------------
  router.post('/stream', requireAskAccess, requireFeature('ai_generation'), audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = AskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendBadRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    const { query, provider, model, apiKey, history } = parsed.data;
    const startedAt = Date.now();
    // Once the provider has started responding (a paid call) a later failure or
    // abort keeps the slot; a failure before that refunds it.
    await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', serviceName: 'ask', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
      let providerContacted = false;
      ctx.log('INFO', 'Ask how-to stream requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveModelSelection({ provider, model, apiKey }).model;

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
      const { sources, events } = streamHowTo({ model: aiModel, query, index, history, abortSignal: sse.signal, maxOutputTokens: ASK_MAX_OUTPUT_TOKENS });

      // Emit the grounded sources up-front so the UI can show them while tokens arrive.
      sse.send({ type: 'sources', data: sources });

      // A provider error throws out of `events` into the error handler below.
      for await (const event of events) {
        if (event.type === 'provider-responded') {
          providerContacted = true;
          slot.markConsumed();
          continue;
        }
        if (sse.aborted()) break;
        sse.send({ type: 'token', data: event.text });
      }

      if (!sse.aborted()) {
        sse.done({ type: 'done' });
        // Completed stream keeps the reserved slot (provider round-trip incurred).
        recordAi('howto-stream', provider, 'success', startedAt);
        auditAskQuery(userId, orgId, { queryLength: query.length, sources: sources.length, streamed: true, outcome: 'success' });
      } else {
        if (!providerContacted) slot.refund();
        recordAi('howto-stream', provider, 'aborted', startedAt);
        auditAskQuery(userId, orgId, { queryLength: query.length, streamed: true, outcome: 'failure' });
      }
      res.end();
    }, (error) => {
      const message = errorMessage(error);
      logger.error('Ask how-to stream failed', { requestId: ctx.requestId, error: message });
      recordAi('howto-stream', provider, 'error', startedAt);
      auditAskQuery(userId, orgId, { queryLength: query.length, streamed: true, outcome: 'failure' });
      handleAIError(res, message, 'Failed to answer the question');
    });
  }));

  return router;
}
