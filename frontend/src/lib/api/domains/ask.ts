// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';

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
 * "Ask" agent client — read-only, grounded how-to over the platform docs. Talks to
 * the `ask` service via nginx (`/api/ask/*`).
 */
export function askApi(core: ApiCore) {
  return {
    /** List the AI providers (and their models) configured on the ask service. */
    getAskProviders: async () => {
      return core.request<ApiResponse<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>>('/api/ask/providers');
    },

    /**
     * Stream a tool-calling agent turn — the assistant can answer how-to questions
     * AND draft resources (pipelines). Yields `token`, `sources`, `tool-call`, and
     * `proposal` events (a proposal is a DRAFT the user confirms; nothing is created
     * until the user commits it via the normal create API).
     */
    askAgentStream: async function* (query: string, opts: AskStreamOptions = {}) {
      yield* core.streamRequest('/api/ask/agent/stream', {
        query,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.history ? { history: opts.history } : {}),
        ...(opts.repoToken ? { repoToken: opts.repoToken } : {}),
      });
    },
  };
}
