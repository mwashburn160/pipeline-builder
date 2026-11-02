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
  initSSEStream,
  requireFeature,
  sendBadRequest,
  sendSuccess,
  actorId,
  recordAudit,
  validateBody,
} from '@pipeline-builder/api-core';
import type { QuotaReserveResult, QuotaService } from '@pipeline-builder/api-core';
import { withQuotaReservation, withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { AskBodySchema, AskFeedbackSchema } from '../request-schema.js';
import { recordAi, recordAskFeedback, recordHelpSearchMiss } from '../services/ai-metrics.js';
import { getDocsIndex } from '../services/docs-index.js';
import { askModelAvailability, sendAskFailure } from '../services/model-window.js';
import { ASK_MAX_OUTPUT_TOKENS } from '../services/model.js';

const logger = createLogger('ask');

/**
 * Fire-and-forget audit of a read-only how-to turn — SAFE METADATA ONLY (query length,
 * source count, streamed flag, outcome, the provider/model that answered and how the
 * `aiCalls` slot settled), never the raw query text.
 */
function auditAskQuery(
  userId: string,
  orgId: string,
  details: {
    queryLength: number;
    sources?: number;
    streamed: boolean;
    outcome: 'success' | 'failure';
    provider: string;
    model?: string;
    quota: AskQuotaDetail;
  },
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
 * The `aiCalls` slot a turn reserved, as the audit trail records it. `slot` is how
 * it SETTLED — `kept` once the provider responded (the cost was incurred), else
 * `refunded` — and `used`/`limit` are the reservation's view of the period, so a
 * quota dispute can be answered from the trail rather than from the counter's
 * current value. Exported for the agent route, which records the same shape.
 */
export interface AskQuotaDetail {
  type: 'aiCalls';
  slot: 'kept' | 'refunded';
  used?: number;
  limit?: number;
}

/** Build {@link AskQuotaDetail} from the reservation (absent when the body never ran). */
export function askQuotaDetail(reservation: QuotaReserveResult | undefined, kept: boolean): AskQuotaDetail {
  return {
    type: 'aiCalls',
    slot: kept ? 'kept' : 'refunded',
    ...(reservation ? { used: reservation.quota.used, limit: reservation.quota.limit } : {}),
  };
}

/** True when a failure itself says the provider was reached (see withQuotaReservation). */
export function errorSaysProviderContacted(error: unknown): boolean {
  return (error as { providerContacted?: unknown } | null)?.providerContacted === true;
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

  // -- GET /ask/availability  can the assistant answer right now? ------------
  //
  // Asked by the panel BEFORE the user types, so it can open straight into help
  // topics rather than inviting a question that is going to fail. Outside its
  // business-hours window `ask-model` has zero replicas, and the only signal
  // used to be the failed turn itself.
  //
  // Resolution is CONFIGURATION ONLY — `resolveModelSelection` never opens a
  // socket (see services/model-window.ts) — so this stays a cheap, side-effect
  // free read and never wakes or probes the model. It therefore PREDICTS from
  // the configured schedule rather than observing the Deployment: a `true` here
  // is "no reason to think it is off", and a turn that still fails is explained
  // by `sendAskFailure` as before. Deliberately no quota reservation: no
  // provider is contacted and nothing is billed.
  //
  // `{}` asks for the same default the routes below resolve when the caller
  // names no provider — the registry's first configured one.
  router.get('/availability', requireAskAccess, requireFeature('ai_generation'), withRoute(async ({ res }) => {
    let providerId: string | undefined;
    try {
      providerId = resolveModelSelection({}).provider;
    } catch {
      // Nothing resolves: no API key and no OPENAI_COMPATIBLE_BASE_URL. That is
      // a real "cannot answer", and unlike the schedule it does not come back on
      // its own — askModelAvailability reports it as not-configured.
      providerId = undefined;
    }
    return sendSuccess(res, 200, askModelAvailability(providerId));
  }));

  // -- POST /ask/feedback  was that answer any good? -------------------------
  //
  // The one thing a turn cannot tell you about itself. `ask.query` already
  // records that a question was asked and that it succeeded, but "succeeded"
  // only means the provider streamed something — a confident wrong answer is
  // indistinguishable from a right one, and nothing anywhere said which docs the
  // assistant answers badly from. Rated answers carry the DOC IDS they cited, so
  // the trail points at the file to fix.
  //
  // Also takes `help-search-miss`: a help search that found nothing, counted
  // only. It shares this route rather than getting its own because it is the
  // same question — "where is the corpus failing readers" — and a route per
  // telemetry shape is how services grow a dozen of them.
  //
  // NO free text reaches this endpoint; the schema has nowhere to put it. The
  // audit convention here is safe metadata only, and a question or a search term
  // is the user's words.
  //
  // NOT gated on `ai_generation`, unlike every route around it. Feedback is
  // about the DOCS corpus, which help serves to everyone — a reader on a
  // help-topics deployment, or an org without the AI entitlement, is exactly
  // whose failed searches this is meant to count, and the gate would drop them
  // silently. Nothing is bypassed: an answer rating can only follow a turn that
  // was itself gated, and `requireAskAccess` still applies.
  //
  // No quota: nothing is generated and no provider is contacted. Answers with
  // the ordinary success envelope rather than a bare 204 — the browser client
  // parses every 2xx as the envelope and treats an empty body as a malformed
  // response, so a 204 would make every rating throw in the caller.
  router.post('/feedback', requireAskAccess, audited('ask.feedback'), withRoute(async ({ req, res, orgId, userId }) => {
    const parsed = validateBody(req, AskFeedbackSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { kind, rating, sources } = parsed.value;

    if (kind === 'help-search-miss') {
      recordHelpSearchMiss();
    } else {
      recordAskFeedback(rating!, (sources?.length ?? 0) > 0);
      recordAudit({
        action: 'ask.feedback',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'ask',
        outcome: 'success',
        // `sources` are doc filenames the answer cited — the actionable half.
        details: { rating: rating!, sources: sources ?? [] },
      });
    }
    return sendSuccess(res, 200, { recorded: true });
  }));

  // -- POST /ask  grounded how-to answer (non-streaming) ---------------------
  router.post('/', requireAskAccess, requireFeature('ai_generation'), audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = validateBody(req, AskBodySchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { query, provider, model, apiKey, history } = parsed.value;
    const startedAt = Date.now();
    let resolvedProvider: string | undefined = provider;
    let resolvedModel: string | undefined = model;
    let reservation: QuotaReserveResult | undefined;
    let providerContacted = false;
    // The provider STARTED responding (a paid call) marks the slot consumed — the
    // same `provider-responded` signal the stream path uses. The answer is
    // collected from the stream rather than a one-shot generate, because a
    // one-shot call gives no such signal: a provider that responded and THEN
    // failed (mid-body error, client abort) looked "never contacted" and was
    // refunded for free.
    await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', serviceName: 'ask', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
      reservation = slot.reservation;
      ctx.log('INFO', 'Ask how-to requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      // The RESOLVED provider, not the requested one: `provider` is usually
      // absent and the registry picks the first configured provider, so the
      // error path needs what actually ran to decide whether the ask-model
      // schedule is the explanation.
      const selection = resolveModelSelection({ provider, model, apiKey });
      resolvedProvider = selection.provider;
      resolvedModel = selection.modelId;
      const aiModel = selection.model;
      const { sources, events } = streamHowTo({ model: aiModel, query, index, history, abortSignal: clientAbortSignal(res), maxOutputTokens: ASK_MAX_OUTPUT_TOKENS });
      let text = '';
      for await (const event of events) {
        if (event.type === 'provider-responded') {
          providerContacted = true;
          slot.markConsumed();
        } else {
          text += event.text;
        }
      }
      const result = { text, sources };
      ctx.log('COMPLETED', 'Ask how-to answered', { sources: result.sources.length });
      recordAi('howto', provider, 'success', startedAt);
      auditAskQuery(userId, orgId, {
        queryLength: query.length,
        sources: result.sources.length,
        streamed: false,
        outcome: 'success',
        provider: resolvedProvider,
        model: resolvedModel,
        quota: askQuotaDetail(reservation, true),
      });
      sendSuccess(res, 200, result);
    }, (error) => {
      const message = errorMessage(error);
      logger.error('Ask how-to failed', { requestId: ctx.requestId, error: message });
      recordAi('howto', provider, 'error', startedAt);
      auditAskQuery(userId, orgId, {
        queryLength: query.length,
        streamed: false,
        outcome: 'failure',
        provider: resolvedProvider ?? 'default',
        model: resolvedModel,
        quota: askQuotaDetail(reservation, providerContacted || errorSaysProviderContacted(error)),
      });
      sendAskFailure(res, message, 'Failed to answer the question', resolvedProvider);
    });
  }));

  // -- POST /ask/stream  grounded how-to answer as SSE -----------------------
  router.post('/stream', requireAskAccess, requireFeature('ai_generation'), audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = validateBody(req, AskBodySchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { query, provider, model, apiKey, history } = parsed.value;
    const startedAt = Date.now();
    let resolvedProvider: string | undefined = provider;
    let resolvedModel: string | undefined = model;
    let reservation: QuotaReserveResult | undefined;
    // Once the provider has started responding (a paid call) a later failure or
    // abort keeps the slot; a failure before that refunds it.
    let providerContacted = false;
    await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', serviceName: 'ask', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
      reservation = slot.reservation;
      ctx.log('INFO', 'Ask how-to stream requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      // The RESOLVED provider, not the requested one: `provider` is usually
      // absent and the registry picks the first configured provider, so the
      // error path needs what actually ran to decide whether the ask-model
      // schedule is the explanation.
      const selection = resolveModelSelection({ provider, model, apiKey });
      resolvedProvider = selection.provider;
      resolvedModel = selection.modelId;
      const aiModel = selection.model;

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
        auditAskQuery(userId, orgId, {
          queryLength: query.length,
          sources: sources.length,
          streamed: true,
          outcome: 'success',
          provider: resolvedProvider,
          model: resolvedModel,
          quota: askQuotaDetail(reservation, true),
        });
      } else {
        if (!providerContacted) slot.refund();
        recordAi('howto-stream', provider, 'aborted', startedAt);
        auditAskQuery(userId, orgId, {
          queryLength: query.length,
          streamed: true,
          outcome: 'failure',
          provider: resolvedProvider,
          model: resolvedModel,
          quota: askQuotaDetail(reservation, providerContacted),
        });
      }
      res.end();
    }, (error) => {
      const message = errorMessage(error);
      logger.error('Ask how-to stream failed', { requestId: ctx.requestId, error: message });
      recordAi('howto-stream', provider, 'error', startedAt);
      auditAskQuery(userId, orgId, {
        queryLength: query.length,
        streamed: true,
        outcome: 'failure',
        provider: resolvedProvider ?? 'default',
        model: resolvedModel,
        quota: askQuotaDetail(reservation, providerContacted || errorSaysProviderContacted(error)),
      });
      sendAskFailure(res, message, 'Failed to answer the question', resolvedProvider);
    });
  }));

  return router;
}
