// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolveModelSelection, stepCountIs, streamText } from '@pipeline-builder/ai-core';
import {
  audited,
  createLogger,
  errorMessage,
  handleAIError,
  initSSEStream,
  requireFeature,
  reserveQuota,
  sendBadRequest,
  actorId,
  recordAudit,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withQuotaReservation, withRoute, incCounter, withSpan } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { requireAskAccess } from '../authz.js';
import { AskBodySchema } from '../request-schema.js';
import { buildAgentTools } from '../services/agent-tools.js';
import { recordAi } from '../services/ai-metrics.js';
import { getDocsIndex } from '../services/docs-index.js';
import { pipelineClient, pluginClient } from '../services/internal-http.js';
import { ASK_MAX_OUTPUT_TOKENS } from '../services/model.js';

const logger = createLogger('ask-agent');

const AGENT_SYSTEM = [
  'You are the Pipeline Builder "Ask" assistant. You help users understand and use the platform.',
  '',
  'Tools:',
  '- answer_how_to: look up docs to answer how-to / functionality questions. Use it before',
  '  answering any "how do I…" question, and answer only from what it returns; if it has no',
  '  relevant docs, say so — never invent commands, env vars, or endpoints.',
  '- list_pipelines / inspect_pipeline / list_templates: see what already exists when that helps',
  '  you reason (list_templates also shows each template\'s declared input variables).',
  '- propose_pipeline_from_repo: when the user gives a Git repository URL, draft the pipeline from',
  '  an analysis of that repository (prefer it over propose_pipeline for repos).',
  '- propose_pipeline / propose_plugin / propose_template: when the user asks to create/build a',
  '  pipeline, plugin, or reusable template, draft it with the matching tool. Use propose_template',
  '  (with {{ vars.NAME }} placeholders + declared inputs) when they want something REUSABLE/parameterized.',
  '- propose_pipeline_from_template: when the user wants a pipeline built FROM an existing template,',
  '  find it with list_templates, then fill its inputs to render a concrete pipeline draft.',
  '  These DO NOT create anything — the user reviews and confirms the draft in the UI. Creating a',
  '  plugin then runs an async build. Never say you created something; say you drafted it for review.',
  '',
  'Be concise and concrete. This assistant is read-only: it proposes, it never changes anything.',
].join('\n');

/**
 * The tool-calling "Ask" agent. Streams the model's reasoning and any tool
 * proposals over SSE. Every tool acts as the calling user via their forwarded bearer
 * token, and `propose_pipeline` only DRAFTS — the create is a separate confirmed
 * action in the UI. Reuses `ai_generation` gating.
 *
 * Quota: this turn reserves ONE `aiCalls` slot for the agent's own reasoning
 * (kept once the provider has responded; refunded on an abort/error before it did). Note the delegated generators —
 * `propose_pipeline`/`propose_plugin` → pipeline/plugin `/generate` — each reserve
 * their OWN `aiCalls` slot (they are separate model invocations), so a turn that
 * drafts a pipeline/plugin draws more than one slot. `propose_template` generates
 * in-process and reserves its own slot per invocation (see `chargeAiCall`); every
 * model call is capped at ASK_MAX_OUTPUT_TOKENS.
 *
 * SSE events:
 *   { type: 'token', data: string }             — assistant text delta
 *   { type: 'tool-call', data: { toolName } }    — a tool started (UI can show a spinner)
 *   { type: 'proposal', data: {...} }            — a reviewable draft (propose_* tools)
 *   { type: 'done' } then [DONE]
 *
 * @param quotaService - Shared quota service
 * @returns Express Router with the agent endpoint
 */
export function createAgentRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  router.post('/agent/stream', requireAskAccess, requireFeature('ai_generation'), audited('ask.agent.turn'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const parsed = AskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendBadRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request');
    }
    // The agent's tools act as the calling user — forward THEIR bearer token.
    const userAuth = req.headers.authorization;
    if (!userAuth) {
      return sendBadRequest(res, 'Missing Authorization header');
    }
    const { query, provider, model, apiKey, history, repoToken } = parsed.data;

    // Service-minted header for the quota reserve/refund (the quota /increment
    // endpoint rejects user principals) — distinct from the user token above.
    // The provider actually RESPONDED once the SDK emits a 'start-step' part.
    // The ai SDK emits 'start' synchronously before any provider call, and
    // 'start-step' only on the first chunk of the provider's response stream; a
    // provider failure before that (bad key, 5xx, network) surfaces as a bare
    // 'error' part with no 'start-step'. Keep the slot once contacted (its $ cost
    // was incurred); refund otherwise.
    let providerContacted = false;

    // Audit trail (safe metadata only — never the raw query text): what tools the
    // agent used, which drafts it proposed, and the outcome. Declared out here so the
    // catch/abort paths can audit a failed turn too.
    const toolsCalled: string[] = [];
    const proposalKinds: string[] = [];
    // AI observability, so on-call can see a provider brownout or a token-spend
    // runaway. Label `provider` with the requested one (or 'default' when the
    // server picks) — kept low-cardinality (no per-model label).
    const providerLabel = provider ?? 'default';
    const startedAt = Date.now();
    const auditTurn = (outcome: 'success' | 'failure') =>
      recordAudit({
        action: 'ask.agent.turn',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'ask',
        outcome,
        details: { queryLength: query.length, toolsCalled: Array.from(new Set(toolsCalled)), proposals: proposalKinds },
      });

    await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', serviceName: 'ask', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
      ctx.log('INFO', 'Ask agent turn requested', { queryLength: query.length, provider, model });
      const index = await getDocsIndex();
      const aiModel = resolveModelSelection({ provider, model, apiKey }).model;
      const tools = buildAgentTools({
        index,
        pipeline: pipelineClient(userAuth),
        plugin: pluginClient(userAuth),
        model: aiModel,
        defaults: { provider, model, repoToken },
        // Authenticated org — injected into tenant-scoping tool inputs so the
        // model can't target another tenant (prompt-injection defense).
        orgId,
        // An in-process generating tool pays its OWN aiCalls slot (the turn's slot
        // covers the agent's reasoning only).
        chargeAiCall: async () => {
          const extra = await reserveQuota(quotaService, orgId, 'aiCalls', slot.serviceAuth);
          if (!extra.exceeded) incCounter('ai_tool_generation_charged_total', { tool: 'propose_template' });
          return !extra.exceeded;
        },
        maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
      });

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
      // Abort the model loop when the client disconnects (avoids wasted spend).
      const abortSignal = sse.signal;
      // Custom span around the model's tool-calling loop — the AI path is the
      // thing an operator actually debugs (slow/hung generation, provider stalls),
      // and auto-instrumentation gives it no detail. `span` records tool usage.
      const result = await withSpan('ask.agent.turn', async (span) => {
        const stream = streamText({
          model: aiModel,
          system: AGENT_SYSTEM,
          messages: [...(history ?? []), { role: 'user', content: query }],
          tools,
          stopWhen: stepCountIs(6),
          // Per-step output cap: with the 6-step bound this caps what one turn's
          // single aiCalls slot can cost.
          maxOutputTokens: ASK_MAX_OUTPUT_TOKENS,
          abortSignal,
        });

        for await (const part of stream.fullStream) {
          if (part.type === 'start-step') { providerContacted = true; slot.markConsumed(); }
          if (abortSignal.aborted) break;
          switch (part.type) {
            case 'text-delta':
              sse.send({ type: 'token', data: part.text });
              break;
            case 'tool-call':
              toolsCalled.push(part.toolName);
              span.addEvent('tool-call', { toolName: part.toolName });
              sse.send({ type: 'tool-call', data: { toolName: part.toolName } });
              break;
            case 'tool-result':
              if (part.toolName.startsWith('propose_')) {
                proposalKinds.push((part.output as { kind?: string })?.kind ?? part.toolName.replace('propose_', ''));
              }
              // Surface grounded sources (how-to) and reviewable drafts (propose_*) to
              // the UI; list_pipelines feeds the model but needs no client event.
              if (part.toolName === 'answer_how_to') {
                const sources = (part.output as { sources?: unknown })?.sources;
                if (sources) sse.send({ type: 'sources', data: sources });
              } else if (part.toolName.startsWith('propose_')) {
                // Every propose_* tool returns a reviewable draft (pipeline/plugin/template).
                sse.send({ type: 'proposal', data: part.output });
              }
              break;
            case 'error':
              throw new Error(errorMessage(part.error));
            default:
              break;
          }
        }
        return stream;
      }, { 'pb.provider': providerLabel });

      if (!abortSignal.aborted) {
        sse.done({ type: 'done' });
        recordAi('agent', provider, 'success', startedAt);
        // Token accounting (best-effort): usage resolves after the stream; field
        // names vary across ai-sdk versions, so read both. Never blocks the turn.
        // result.usage is a PromiseLike (no .catch), so adopt it into a real Promise.
        void Promise.resolve(result.usage)
          .then((u) => {
            const usage = u as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
            incCounter('ai_tokens_total', { route: 'agent', kind: 'input' }, usage.inputTokens ?? usage.promptTokens ?? 0);
            incCounter('ai_tokens_total', { route: 'agent', kind: 'output' }, usage.outputTokens ?? usage.completionTokens ?? 0);
          })
          .catch(() => { /* usage unavailable for this provider — skip */ });
        auditTurn('success');
      } else {
        // Refund ONLY if the provider never responded; an abort after its
        // first response chunk still cost us the call.
        if (!providerContacted) slot.refund();
        recordAi('agent', provider, 'aborted', startedAt);
        auditTurn('failure'); // client aborted mid-turn
      }
      res.end();
    }, (error) => {
      const message = errorMessage(error);
      logger.error('Ask agent turn failed', { requestId: ctx.requestId, error: message });
      recordAi('agent', provider, 'error', startedAt);
      auditTurn('failure');
      handleAIError(res, message, 'The assistant failed to respond');
    });
  }));

  return router;
}
