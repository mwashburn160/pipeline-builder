// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import api from '@/lib/api';
import type { StreamEvent } from '@/lib/api/core';
import { splitAskAgentModel } from '@/lib/ai-constants';

/**
 * What the create dialogs ask the agent to draft: the instruction wrapped
 * around the user's input (it names the tool to use) and the proposal kind
 * that answers it.
 */
const AGENT_DRAFT = {
  pipeline: {
    expects: 'pipeline',
    query: (input: string) => `Draft a pipeline using propose_pipeline for this request:\n\n${input}`,
  },
  'pipeline-from-repo': {
    expects: 'pipeline',
    query: (input: string) => `Draft a pipeline for the Git repository ${input} using propose_pipeline_from_repo.`,
  },
  plugin: {
    expects: 'plugin',
    query: (input: string) => `Draft a plugin using propose_plugin for this request:\n\n${input}`,
  },
} as const satisfies Record<string, { expects: 'pipeline' | 'plugin'; query: (input: string) => string }>;

export type AgentDraftKind = keyof typeof AGENT_DRAFT;

/**
 * Generate a draft through the Ask agent, adapted to the event stream the AI
 * generation tabs already consume (`useAiStreamGeneration`): the agent's
 * matching `proposal` becomes the terminal `done` event (preceded by an
 * `analyzed` event when the draft came from a repository analysis), agent
 * `tool-call` activity is forwarded as-is, and a turn that ends without a
 * usable draft becomes an `error` carrying whatever the agent said instead.
 *
 * `agentModelId` is the composite id from the "Ask agent" provider entry; it
 * is split back into the real provider/model the agent (and the generator its
 * tool delegates to) should use. Drafts only — nothing is created here.
 */
export async function* streamAgentDraft(
  kind: AgentDraftKind,
  input: string,
  agentModelId: string,
  opts: { repoToken?: string } = {},
): AsyncGenerator<StreamEvent> {
  const { provider, model } = splitAskAgentModel(agentModelId);
  const { expects: expected, query } = AGENT_DRAFT[kind];
  let said = '';

  for await (const event of api.askAgentStream(query(input), {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(opts.repoToken ? { repoToken: opts.repoToken } : {}),
  })) {
    switch (event.type) {
      case 'token':
        if (typeof event.data === 'string') said += event.data;
        break;
      case 'tool-call':
        yield event;
        break;
      case 'proposal': {
        const { kind: draftKind, analysis, ...payload } = (event.data ?? {}) as Record<string, unknown> & { kind?: string; analysis?: unknown };
        if (draftKind !== expected) break; // e.g. a template draft — not what this dialog creates
        const complete = expected === 'plugin' ? payload.config && payload.dockerfile : payload.props;
        if (!complete) break; // the delegated generation failed; the agent explains in its text
        if (analysis) yield { type: 'analyzed', data: analysis };
        yield { type: 'done', data: payload };
        return;
      }
      case 'error':
        yield event;
        return;
      default:
        break;
    }
  }

  const reply = said.trim();
  yield {
    type: 'error',
    message: reply
      ? `The Ask agent didn't draft a ${expected}: ${reply}`
      : `The Ask agent didn't draft a ${expected} — try rephrasing your request.`,
  };
}
