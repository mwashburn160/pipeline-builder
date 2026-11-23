// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';
import type { AiDraftFeature, AiDraftOutcome } from '@/types/ai-usage';
import { boundAskHistory } from '@/lib/ask-history';

/** A documentation source the "Ask" answer was grounded in. */
export interface AskSource {
  id: string;
  title?: string;
  url?: string;
}

/** A prior conversation turn sent back for multi-turn context (client-held in v1). */
export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskStreamOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
  history?: AskTurn[];
  /** Private-repo token for the agent's repo-analysis tool (never shown to the model). */
  repoToken?: string;
}

/**
 * Whether the assistant can answer right now, from `GET /ask-agent/availability`.
 *
 * The panel asks BEFORE offering the question box, so a deployment whose
 * self-hosted model is scaled to zero by its business-hours schedule opens
 * straight into help topics instead of inviting a question that will fail.
 *
 * The server PREDICTS this from the configured schedule rather than probing the
 * model, so `available: true` means "no reason to think it is off" — a turn can
 * still fail, and that failure carries its own explanation.
 */
export type AskAvailability =
  | { available: true }
  | {
    available: false;
    /**
     * `scheduled-off` returns by itself; `not-configured` does not; `disabled`
     * means the organization's administrators turned AI off (`AI_DISABLED`) —
     * it returns only when one turns it back on in Settings; `unreachable` comes
     * only from a live probe (`probe: true`) that found the self-hosted model
     * not answering.
     */
    reason: 'scheduled-off' | 'not-configured' | 'disabled' | 'unreachable';
    /** A ready sentence for the user, with times already stated as UTC. */
    message: string;
    /** When it returns, e.g. `07:45 UTC`. */
    resumesAt?: string;
    /** The configured window, e.g. `07:45-17:00 UTC, Monday to Friday`. */
    window?: string;
  };

/**
 * "Ask" agent client — read-only, grounded how-to over the platform docs. Talks to
 * the `ask-agent` service via nginx (`/api/ask-agent/*`).
 */
export function askApi(core: ApiCore) {
  return {
    /**
     * Whether the assistant can answer right now. Cheap and side-effect free:
     * the server resolves provider CONFIGURATION only and never opens a socket
     * to the model, so this neither wakes nor probes it.
     *
     * `probe: true` additionally has the server make one short live request to
     * the self-hosted model (cached server-side for a few seconds); `provider`
     * asks about that provider instead of the predicted default.
     */
    getAskAvailability: async (opts: { probe?: boolean; provider?: string } = {}) => {
      const params = new URLSearchParams();
      if (opts.probe) params.set('probe', 'true');
      if (opts.provider) params.set('provider', opts.provider);
      const qs = params.toString();
      return core.request<ApiResponse<AskAvailability>>(`/api/ask-agent/availability${qs ? `?${qs}` : ''}`);
    },

    /**
     * Record a reader's verdict on an answer, or a help search that found
     * nothing. Fire-and-forget: the caller must not block or surface a failure,
     * because telemetry failing is not the reader's problem.
     *
     * Carries no free text — the server has nowhere to put a question or a
     * search term, by design.
     */
    sendAskFeedback: async (body:
      | { kind: 'answer'; rating: 'up' | 'down'; sources?: string[] }
      | { kind: 'help-search-miss' }) => {
      return core.request<ApiResponse<{ recorded: boolean }>>('/api/ask-agent/feedback', { method: 'POST', body: JSON.stringify(body) });
    },

    /**
     * Record what the user did with one AI-generated draft (accepted, edited
     * then accepted, or discarded) for the AI usage report's acceptance rate.
     * Carries the feature, the outcome and the single-use `draftId` the
     * generator issued with the draft — no draft, no prompt. Fire-and-forget
     * like the feedback above: the caller never blocks on it.
     */
    recordAiDraftOutcome: async (feature: AiDraftFeature, outcome: AiDraftOutcome, draftId: string) => {
      return core.request<ApiResponse<{ recorded: boolean }>>('/api/ask-agent/draft-outcome', { method: 'POST', body: JSON.stringify({ feature, outcome, draftId }) });
    },

    /** List the AI providers (and their models) configured on the ask-agent service. */
    getAskProviders: async () => {
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/ask-agent/providers');
    },

    /**
     * Stream a tool-calling agent turn — the assistant can answer how-to questions
     * AND draft resources (pipelines). Yields `token`, `sources`, `tool-call`, and
     * `proposal` events (a proposal is a DRAFT the user confirms; nothing is created
     * until the user commits it via the normal create API).
     */
    askAgentStream: async function* (query: string, opts: AskStreamOptions = {}) {
      yield* core.streamRequest('/api/ask-agent/agent/stream', {
        query,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.history ? { history: boundAskHistory(opts.history) } : {}),
        ...(opts.repoToken ? { repoToken: opts.repoToken } : {}),
      });
    },
  };
}
