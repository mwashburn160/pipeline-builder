// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registry } from '../registry.js';

const tags = ['Ask'];
const auth = [{ bearerAuth: [] }];

/**
 * OpenAPI definitions for the "Ask" assistant service (api/ask), mounted at
 * `/ask`. All routes are gated by the `ai_generation` feature and are READ /
 * PROPOSE only — the agent never mutates; `propose_*` tool results are drafts the
 * user confirms in the UI.
 */
export function registerAskRoutes(): void {
  registry.registerPath({
    method: 'get',
    path: '/ask/providers',
    summary: 'List configured AI providers',
    description: 'The AI providers/models available to the Ask assistant (from server env — cloud keys and/or the OpenAI-compatible local endpoint).',
    tags,
    security: auth,
    responses: { 200: { description: 'Configured providers' }, 403: { description: 'ai_generation feature required' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/ask',
    summary: 'Grounded how-to answer (non-streaming)',
    description: 'Answer a platform how-to question grounded in the docs corpus. Reserves one aiCalls quota slot.',
    tags,
    security: auth,
    responses: {
      200: { description: 'Answer with grounded sources' },
      403: { description: 'ai_generation feature required' },
      429: { description: 'aiCalls quota exceeded or rate limited' },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/ask/stream',
    summary: 'Grounded how-to answer (SSE stream)',
    description: 'Same as POST /ask but streams the grounded sources then answer tokens as Server-Sent Events.',
    tags,
    security: auth,
    responses: {
      200: { description: 'text/event-stream of sources + answer tokens' },
      403: { description: 'ai_generation feature required' },
      429: { description: 'aiCalls quota exceeded or rate limited' },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/ask/agent/stream',
    summary: 'Tool-calling Ask agent (SSE stream)',
    description: 'Runs the tool-calling assistant loop and streams reasoning tokens, tool-call events, and reviewable `propose_*` drafts (pipeline/plugin/template) as SSE. Read-only: proposals are confirmed separately in the UI.',
    tags,
    security: auth,
    responses: {
      200: { description: 'text/event-stream of tokens, tool-calls, and proposal drafts' },
      403: { description: 'ai_generation feature required' },
      429: { description: 'aiCalls quota exceeded or rate limited' },
    },
  });
}
