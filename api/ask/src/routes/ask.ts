// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  ASK_HOWTO_PROMPT_VERSION,
  aiCallSettings,
  aiUsageAuditDetails,
  getAvailableProviders,
  resolveModelSelection,
  resolveOrgModelSelection,
  runWithFailover,
  streamHowTo,
  tokenUsage,
} from '@pipeline-builder/ai-core';
import type { AIUsageAuditDetails, LanguageModelUsage, ResolvedModelSelection } from '@pipeline-builder/ai-core';
import {
  audited,
  clientAbortSignal,
  createLogger,
  errorMessage,
  fetchOrgAIAccess,
  initSSEStream,
  isKeylessProviderId,
  requireFeature,
  requireOrgAIEnabled,
  sendBadRequest,
  sendSuccess,
  actorId,
  recordAudit,
  validateBody,
  type AiQuotaSettlement,
  type QuotaService,
} from '@pipeline-builder/api-core';
import { withAiCallReservation, withRoute, type AiCallSlot, type AiSlotWaiver } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { AskBodySchema, AskFeedbackSchema } from '../request-schema.js';
import { recordAi, recordAiTokens, recordAskFeedback, recordHelpSearchMiss } from '../services/ai-metrics.js';
import { getDocsIndex } from '../services/docs-index.js';
import { askModelAvailability, sendAskFailure } from '../services/model-window.js';
import { ASK_MAX_OUTPUT_TOKENS, ASK_TEMPERATURE } from '../services/model.js';

const logger = createLogger('ask');

/**
 * Fire-and-forget audit of a read-only how-to turn — SAFE METADATA ONLY (query length,
 * source count, streamed flag, outcome, and the shared AI usage block: the provider
 * and model that ANSWERED, whose key paid, tokens in/out, the prompt version and how
 * the `aiCalls` slot settled), never the raw query text.
 */
function auditAskQuery(
  userId: string,
  orgId: string,
  details: {
    queryLength: number;
    sources?: number;
    streamed: boolean;
    outcome: 'success' | 'failure';
    quota: AskQuotaDetail;
    /** Absent when the turn failed before a provider was chosen. */
    ai?: AIUsageAuditDetails;
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
 * The provider a turn for this org would be answered by, for the availability
 * PREDICTION only: the org's first own (key-based) provider, else the platform
 * default. Reads the org's posture (cached), never its key — `/availability` is
 * asked on every panel open and must not cause a key read.
 */
async function predictedProvider(orgId: string): Promise<{ provider?: string; aiEnabled: boolean }> {
  const access = await fetchOrgAIAccess(orgId);
  if (!access.aiEnabled) return { aiEnabled: false };
  const own = access.providers.find((p) => !isKeylessProviderId(p));
  return { provider: own ?? platformDefaultProvider(), aiEnabled: true };
}

/** The registry's default provider, or undefined when nothing is configured. */
function platformDefaultProvider(): string | undefined {
  try {
    return resolveModelSelection({}).provider;
  } catch {
    return undefined;
  }
}

/** The client-facing "answered by" block for a turn's `done` event. */
export function servedByOf(served: ResolvedModelSelection): { provider: string; model: string; fallbackFrom?: string } {
  return { provider: served.provider, model: served.modelId, ...(served.fallbackFrom ? { fallbackFrom: served.fallbackFrom } : {}) };
}

/** What a how-to turn records about the call that answered it. */
function usageBlock(served: ResolvedModelSelection | undefined, usage: LanguageModelUsage | undefined, kept: boolean): AIUsageAuditDetails | undefined {
  return served ? aiUsageAuditDetails(served, { usage, quotaSlot: kept ? 'kept' : 'refunded', promptVersion: ASK_HOWTO_PROMPT_VERSION }) : undefined;
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
  /** `waived`: no unit was reserved (BYOK key, impersonation, weight-0 model) — see `waived`. */
  slot: AiQuotaSettlement;
  /** Why no unit was reserved (api-server `AiSlotWaiver`). */
  waived?: AiSlotWaiver;
  /** Units the call reserved (its model weight). */
  amount?: number;
  used?: number;
  limit?: number;
}

/** Build {@link AskQuotaDetail} from the call's slot (absent when the body never ran). */
export function askQuotaDetail(slot: Pick<AiCallSlot, 'reservation' | 'waived' | 'amount'> | undefined, kept: boolean): AskQuotaDetail {
  if (slot?.waived) return { type: 'aiCalls', slot: 'waived', waived: slot.waived, amount: 0 };
  return {
    type: 'aiCalls',
    slot: kept ? 'kept' : 'refunded',
    ...(slot ? { amount: slot.amount, used: slot.reservation.quota.used, limit: slot.reservation.quota.limit } : {}),
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
 * pipeline/plugin AI). Each turn resolves its model FIRST, then reserves its
 * `aiCalls` slot (`withAiCallReservation`, via a service-minted auth header — the
 * quota `/increment` endpoint rejects user principals): the model's weight in
 * units, or NOTHING for a BYOK key / impersonation session / weight-0 model. The
 * slot is KEPT once the provider has responded (its $ cost was incurred — even if
 * the client then aborts or a later step fails) and REFUNDED only when the provider
 * was never reached; the turn's tokens are reported to the usage ledger either
 * way. No writes — nothing is mutated here.
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
  // Predicts what the routes below resolve when the caller names no provider:
  // the org's own provider when it configured one, else the registry's first.
  // An org whose administrators switched AI off is told so (`reason: 'disabled'`).
  router.get('/availability', requireAskAccess, requireFeature('ai_generation'), withRoute(async ({ res, orgId }) => {
    let predicted: { provider?: string; aiEnabled: boolean };
    try {
      predicted = await predictedProvider(orgId);
    } catch {
      // Platform could not confirm the org's AI settings. This route only
      // PREDICTS: fall back to the platform default, and let a turn that is then
      // refused explain itself (503) — as the schedule prediction already does.
      predicted = { aiEnabled: true, provider: platformDefaultProvider() };
    }
    if (!predicted.aiEnabled) {
      return sendSuccess(res, 200, {
        available: false,
        reason: 'disabled',
        message: 'AI features are turned off for this organization. The help topics below cover the same material.',
      });
    }
    // No provider (no org key, no platform key, no OPENAI_COMPATIBLE_BASE_URL) is
    // a real "cannot answer", and unlike the schedule it does not come back on
    // its own — askModelAvailability reports it as not-configured.
    return sendSuccess(res, 200, askModelAvailability(predicted.provider));
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
  router.post('/', requireAskAccess, requireFeature('ai_generation'), requireOrgAIEnabled, audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = validateBody(req, AskBodySchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { query, provider, model, apiKey, history } = parsed.value;
    const startedAt = Date.now();
    // The selection that ACTUALLY served the turn (after org-key selection and any
    // failover) — what the metrics, the audit row and the failure explanation use.
    let served: ResolvedModelSelection | undefined;
    let usage: LanguageModelUsage | undefined;
    let aiSlot: AiCallSlot | undefined;
    let providerContacted = false;
    const clientGone = clientAbortSignal(res);
    // The provider STARTED responding (a paid call) marks the slot consumed — the
    // same `provider-responded` signal the stream path uses. The answer is
    // collected from the stream rather than a one-shot generate, because a
    // one-shot call gives no such signal: a provider that responded and THEN
    // failed (mid-body error, client abort) looked "never contacted" and was
    // refunded for free.
    // The model is resolved BEFORE the reservation: it decides the charge (a
    // BYOK key reserves nothing, a weighted model reserves its weight).
    await withAiCallReservation({
      quotaService,
      orgId,
      serviceName: 'ask',
      res,
      logWarn: ctx.log.bind(null, 'WARN'),
      req,
      feature: 'ask',
      resolve: () => resolveOrgModelSelection({ orgId, provider, model, apiKey }),
    }, async (slot, selection) => {
      aiSlot = slot;
      ctx.log('INFO', 'Ask how-to requested', { queryLength: query.length, provider, model, waived: slot.waived });
      const index = await getDocsIndex();
      served = selection;
      // A platform-key provider that fails retryably BEFORE responding is
      // retried on the next platform provider; a BYO/org-key turn never is.
      const { value: result } = await runWithFailover(selection, async (sel) => {
        served = sel;
        const { sources, events } = streamHowTo({
          model: sel.model,
          query,
          index,
          history,
          ...aiCallSettings({ selection: sel, signal: clientGone, maxOutputTokens: ASK_MAX_OUTPUT_TOKENS, temperature: ASK_TEMPERATURE }),
        });
        let text = '';
        for await (const event of events) {
          if (event.type === 'provider-responded') {
            providerContacted = true;
            slot.markConsumed();
          } else if (event.type === 'usage') {
            usage = event.usage;
          } else {
            text += event.text;
          }
        }
        return { text, sources };
      }, { contacted: () => providerContacted, onFailover: (from, to) => ctx.log('WARN', 'Ask how-to failed over', { from, to }) });
      ctx.log('COMPLETED', 'Ask how-to answered', { sources: result.sources.length });
      recordAi('howto', { provider: served.provider, model: served.modelId }, 'success', startedAt);
      recordAiTokens('howto', { provider: served.provider, keySource: served.keySource, tier: req.user?.tier }, tokenUsage(usage));
      slot.reportUsage(tokenUsage(usage));
      auditAskQuery(userId, orgId, {
        queryLength: query.length,
        sources: result.sources.length,
        streamed: false,
        outcome: 'success',
        quota: askQuotaDetail(slot, true),
        ai: usageBlock(served, usage, true),
      });
      sendSuccess(res, 200, result);
    }, (error) => {
      logger.error('Ask how-to failed', { requestId: ctx.requestId, error: errorMessage(error) });
      const kept = providerContacted || errorSaysProviderContacted(error);
      recordAi('howto', { provider: served?.provider, model: served?.modelId }, 'error', startedAt);
      aiSlot?.reportUsage(tokenUsage(usage));
      auditAskQuery(userId, orgId, {
        queryLength: query.length,
        streamed: false,
        outcome: 'failure',
        quota: askQuotaDetail(aiSlot, kept),
        ai: usageBlock(served, usage, kept),
      });
      sendAskFailure(res, error, 'Failed to answer the question', served?.provider);
    });
  }));

  // -- POST /ask/stream  grounded how-to answer as SSE -----------------------
  router.post('/stream', requireAskAccess, requireFeature('ai_generation'), requireOrgAIEnabled, audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = validateBody(req, AskBodySchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { query, provider, model, apiKey, history } = parsed.value;
    const startedAt = Date.now();
    let served: ResolvedModelSelection | undefined;
    let usage: LanguageModelUsage | undefined;
    let aiSlot: AiCallSlot | undefined;
    // Once the provider has started responding (a paid call) a later failure or
    // abort keeps the slot; a failure before that refunds it.
    let providerContacted = false;
    // Resolved BEFORE the reservation (it decides the charge) and before the
    // stream opens, so an AI-off org, an unloadable org key or a missing
    // configuration is an ordinary HTTP error rather than an SSE frame.
    await withAiCallReservation({
      quotaService,
      orgId,
      serviceName: 'ask',
      res,
      logWarn: ctx.log.bind(null, 'WARN'),
      req,
      feature: 'ask',
      resolve: () => resolveOrgModelSelection({ orgId, provider, model, apiKey }),
    }, async (slot, selection) => {
      aiSlot = slot;
      ctx.log('INFO', 'Ask how-to stream requested', { queryLength: query.length, provider, model, waived: slot.waived });
      const index = await getDocsIndex();
      served = selection;

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
      let sourcesSent = false;
      await runWithFailover(selection, async (sel) => {
        served = sel;
        const { sources, events } = streamHowTo({
          model: sel.model,
          query,
          index,
          history,
          ...aiCallSettings({ selection: sel, signal: sse.signal, maxOutputTokens: ASK_MAX_OUTPUT_TOKENS, temperature: ASK_TEMPERATURE }),
        });
        // Emit the grounded sources up-front so the UI can show them while tokens
        // arrive — once: a failover retrieves the same sources for the same query.
        if (!sourcesSent) {
          sse.send({ type: 'sources', data: sources });
          sourcesSent = true;
        }
        // A provider error throws out of `events` into the error handler below.
        for await (const event of events) {
          if (event.type === 'provider-responded') {
            providerContacted = true;
            slot.markConsumed();
            continue;
          }
          if (event.type === 'usage') { usage = event.usage; continue; }
          if (sse.aborted()) break;
          sse.send({ type: 'token', data: event.text });
        }
        return sources.length;
      }, { contacted: () => providerContacted, onFailover: (from, to) => ctx.log('WARN', 'Ask how-to stream failed over', { from, to }) });

      const labels = { provider: served.provider, model: served.modelId };
      if (!sse.aborted()) {
        // Who answered (after org-key selection and any failover) and what it
        // cost — shown under the answer, never key material.
        sse.done({ type: 'done', data: { servedBy: servedByOf(served), usage: tokenUsage(usage) } });
        // Completed stream keeps the reserved slot (provider round-trip incurred).
        recordAi('howto-stream', labels, 'success', startedAt);
        auditAskQuery(userId, orgId, {
          queryLength: query.length,
          streamed: true,
          outcome: 'success',
          quota: askQuotaDetail(slot, true),
          ai: usageBlock(served, usage, true),
        });
      } else {
        // A no-op once the provider responded: a paid call is never refunded.
        slot.refund();
        recordAi('howto-stream', labels, 'aborted', startedAt);
        auditAskQuery(userId, orgId, {
          queryLength: query.length,
          streamed: true,
          outcome: 'failure',
          quota: askQuotaDetail(slot, providerContacted),
          ai: usageBlock(served, usage, providerContacted),
        });
      }
      recordAiTokens('howto-stream', { provider: served.provider, keySource: served.keySource, tier: req.user?.tier }, tokenUsage(usage));
      slot.reportUsage(tokenUsage(usage));
      res.end();
    }, (error) => {
      logger.error('Ask how-to stream failed', { requestId: ctx.requestId, error: errorMessage(error) });
      const kept = providerContacted || errorSaysProviderContacted(error);
      recordAi('howto-stream', { provider: served?.provider, model: served?.modelId }, 'error', startedAt);
      aiSlot?.reportUsage(tokenUsage(usage));
      auditAskQuery(userId, orgId, {
        queryLength: query.length,
        streamed: true,
        outcome: 'failure',
        quota: askQuotaDetail(aiSlot, kept),
        ai: usageBlock(served, usage, kept),
      });
      sendAskFailure(res, error, 'Failed to answer the question', served?.provider);
    });
  }));

  return router;
}
