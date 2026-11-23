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
  envInt,
  errorMessage,
  fetchOrgAIAccess,
  initSSEStream,
  isKeylessProviderId,
  OPENAI_COMPATIBLE_PROVIDER_ID,
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
import { rateLimitByOrg, withAiCallReservation, withRoute, type AiCallSlot, type AiSlotWaiver } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { AskBodySchema, AskFeedbackSchema } from '../request-schema.js';
import { recordAi, recordAiTokens, recordAskFeedback, recordHelpSearchMiss } from '../services/ai-metrics.js';
import { getDocsIndex } from '../services/docs-index.js';
import { probeSelfHostedModel } from '../services/model-probe.js';
import { askModelAvailability, sendAskFailure } from '../services/model-window.js';
import { ASK_MAX_OUTPUT_TOKENS, ASK_TEMPERATURE } from '../services/model.js';

const logger = createLogger('ask-agent');

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
 * it SETTLED — `kept` once the request was sent to the provider (the cost was
 * incurred), else `refunded` — and `used`/`limit` are the reservation's view of the period, so a
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


/**
 * Read-only "Ask" agent routes: grounded how-to answers over the docs corpus.
 *
 * Gated with `requireFeature('ai_generation')` (reused for v1 — same entitlement as
 * pipeline/plugin AI). Each turn resolves its model FIRST, then reserves its
 * `aiCalls` slot (`withAiCallReservation`, via a service-minted auth header — the
 * quota `/increment` endpoint rejects user principals): the model's weight in
 * units, or NOTHING for a BYOK key / impersonation session / weight-0 model. The
 * slot is CONSUMED the moment the request is sent to the provider (the provider
 * bills what it processed — even if the client then aborts, the call times out or
 * the provider errors) and REFUNDED only on a failure before the send; the turn's
 * tokens are reported to the usage ledger either way. No writes — nothing is mutated here.
 *
 * @param quotaService - Shared quota service
 * @returns Express Router with the ask endpoints
 */
export function createAskRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // -- GET /ask-agent/providers  list configured AI providers ----------------------
  router.get('/providers', requireAskAccess, requireFeature('ai_generation'), withRoute(async ({ res }) => {
    return sendSuccess(res, 200, { providers: getAvailableProviders() });
  }));

  // -- GET /ask-agent/availability  can the assistant answer right now? ------------
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
  //
  // `?probe=true` (opt-in; the Git URL form uses it) additionally makes ONE live
  // request to the self-hosted model server — see services/model-probe.ts — and
  // `?provider=<id>` lets a caller that sends an explicit provider ask about that
  // one instead of the predicted default.
  //
  // Capped per USER (`ASK_AVAILABILITY_RATE_LIMIT_PER_MIN`, default 30) on top
  // of the per-org Ask limit at the mount: the probe reaches the model server,
  // so this route gets a bound of its own (the probe's cache bounds it too).
  const availabilityPerUser = rateLimitByOrg({
    name: 'ask-availability',
    keyBy: 'user',
    max: envInt('ASK_AVAILABILITY_RATE_LIMIT_PER_MIN', 30, { min: 1 }),
    windowMs: 60_000,
    message: 'Too many Ask availability checks',
  });
  router.get('/availability', requireAskAccess, requireFeature('ai_generation'), availabilityPerUser, withRoute(async ({ req, res, orgId }) => {
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
    // Only a configured provider id is honoured from the query string.
    const query = req.query ?? {};
    const requested = typeof query.provider === 'string' ? query.provider : undefined;
    const provider = requested && getAvailableProviders().some((p) => p.id === requested)
      ? requested
      : predicted.provider;

    // No provider (no org key, no platform key, no OPENAI_COMPATIBLE_BASE_URL) is
    // a real "cannot answer", and unlike the schedule it does not come back on
    // its own — askModelAvailability reports it as not-configured.
    const availability = askModelAvailability(provider);

    // Cloud providers are never probed: their uptime is not this deployment's to
    // observe, and a probe would cost nothing useful.
    if (query.probe === 'true' && availability.available && provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      const { reachable } = await probeSelfHostedModel();
      if (!reachable) {
        return sendSuccess(res, 200, {
          available: false,
          reason: 'unreachable',
          message: 'The Ask assistant\'s self-hosted model is not responding. It may be switched off or still starting up — ask an operator to check it.',
        });
      }
    }
    return sendSuccess(res, 200, availability);
  }));

  // -- POST /ask-agent/feedback  was that answer any good? -------------------------
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

  // -- POST /ask-agent  grounded how-to answer (non-streaming) ---------------------
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
    // The provider RESPONDED: gates failover only (the slot is consumed at send).
    let providerResponded = false;
    const clientGone = clientAbortSignal(res);
    // The model is resolved BEFORE the reservation: it decides the charge (a
    // BYOK key reserves nothing, a weighted model reserves its weight).
    await withAiCallReservation({
      quotaService,
      orgId,
      serviceName: 'ask-agent',
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
        // The request is sent below: the slot is spent from here on.
        slot.markConsumed();
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
            providerResponded = true;
          } else if (event.type === 'usage') {
            usage = event.usage;
          } else {
            text += event.text;
          }
        }
        return { text, sources };
      }, { contacted: () => providerResponded, onFailover: (from, to) => ctx.log('WARN', 'Ask how-to failed over', { from, to }) });
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
      const kept = aiSlot?.isConsumed() ?? false;
      recordAi('howto', { provider: served?.provider, model: served?.modelId }, 'error', startedAt);
      // A failed turn still paid for whatever the provider reported before it
      // failed — counted exactly as the stream route counts it.
      recordAiTokens('howto', { provider: served?.provider, keySource: served?.keySource, tier: req.user?.tier }, tokenUsage(usage));
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

  // -- POST /ask-agent/stream  grounded how-to answer as SSE -----------------------
  router.post('/stream', requireAskAccess, requireFeature('ai_generation'), requireOrgAIEnabled, audited('ask.query'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = validateBody(req, AskBodySchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error);
    const { query, provider, model, apiKey, history } = parsed.value;
    const startedAt = Date.now();
    let served: ResolvedModelSelection | undefined;
    let usage: LanguageModelUsage | undefined;
    let aiSlot: AiCallSlot | undefined;
    // The provider RESPONDED: gates failover only. The slot is consumed at SEND, so
    // a later failure, timeout or abort keeps it; a failure before the send refunds.
    let providerResponded = false;
    // Resolved BEFORE the reservation (it decides the charge) and before the
    // stream opens, so an AI-off org, an unloadable org key or a missing
    // configuration is an ordinary HTTP error rather than an SSE frame.
    await withAiCallReservation({
      quotaService,
      orgId,
      serviceName: 'ask-agent',
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
        // The request is sent below: the slot is spent from here on.
        slot.markConsumed();
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
            providerResponded = true;
            continue;
          }
          if (event.type === 'usage') { usage = event.usage; continue; }
          if (sse.aborted()) break;
          sse.send({ type: 'token', data: event.text });
        }
        return sources.length;
      }, { contacted: () => providerResponded, onFailover: (from, to) => ctx.log('WARN', 'Ask how-to stream failed over', { from, to }) });

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
        // A no-op once the request was sent: a sent call is never refunded.
        slot.refund();
        recordAi('howto-stream', labels, 'aborted', startedAt);
        auditAskQuery(userId, orgId, {
          queryLength: query.length,
          streamed: true,
          outcome: 'failure',
          quota: askQuotaDetail(slot, slot.isConsumed()),
          ai: usageBlock(served, usage, slot.isConsumed()),
        });
      }
      recordAiTokens('howto-stream', { provider: served.provider, keySource: served.keySource, tier: req.user?.tier }, tokenUsage(usage));
      slot.reportUsage(tokenUsage(usage));
      res.end();
    }, (error) => {
      logger.error('Ask how-to stream failed', { requestId: ctx.requestId, error: errorMessage(error) });
      const kept = aiSlot?.isConsumed() ?? false;
      recordAi('howto-stream', { provider: served?.provider, model: served?.modelId }, 'error', startedAt);
      // Whatever the provider reported before failing (a how-to answer is ONE
      // step, so there is no per-step usage to sum — a call cut off mid-stream
      // reports none, and nothing is invented in its place).
      recordAiTokens('howto-stream', { provider: served?.provider, keySource: served?.keySource, tier: req.user?.tier }, tokenUsage(usage));
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
