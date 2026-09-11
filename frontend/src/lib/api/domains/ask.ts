// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';

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
}

/**
 * "Ask" agent client — read-only, grounded how-to over the platform docs. Talks to
 * the `ask` service via nginx (`/api/ask/*`).
 */
export function askApi(core: ApiCore) {
  return {
    /**
     * Stream a grounded how-to answer (the lighter RAG endpoint, no tools). Yields a
     * `sources` event first, then `token` events, then `done`.
     */
    askStream: async function* (query: string, opts: AskStreamOptions = {}) {
      yield* core.streamRequest('/api/ask/stream', {
        query,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.history ? { history: opts.history } : {}),
      });
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
      });
    },
  };
}
