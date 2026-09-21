// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Ask agent" as the default AI provider in the create dialogs:
 *  - useAIProviders puts the Ask-agent entry first (so it's selected by default),
 *    with composite provider|model ids built from the ask service's providers,
 *    and omits it when the ask service has nothing configured.
 *  - streamAgentDraft adapts an agent turn to the generation-tab event stream:
 *    the matching proposal becomes `done`, a repo analysis becomes `analyzed`,
 *    and a turn with no usable draft becomes an `error` quoting the agent.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, waitFor } from '@testing-library/react';
import { useAIProviders } from '../src/hooks/useAIProviders';
import { streamAgentDraft } from '../src/lib/ask-agent-draft';

const askAgentStream = jest.fn<AnyFn>();
const getAskProviders = jest.fn<AnyFn>();
const getOrgAIConfig = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    askAgentStream: (...a: unknown[]) => askAgentStream(...a),
    getAskProviders: (...a: unknown[]) => getAskProviders(...a),
    getOrgAIConfig: (...a: unknown[]) => getOrgAIConfig(...a),
  },
}));

type Ev = { type: string; data?: unknown; message?: string };
async function* gen(events: Ev[]) {
  for (const e of events) yield e;
}
async function collect(it: AsyncGenerator<Ev>): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const serverProviders = async () => ({
  data: { providers: [{ id: 'amazon-bedrock', name: 'Amazon Bedrock', models: [{ id: 'claude-sonnet', name: 'Claude Sonnet 4.5' }] }] },
});

describe('useAIProviders({ askAgent: true })', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  });

  it('leads with the Ask agent entry and selects it by default', async () => {
    getAskProviders.mockResolvedValue({
      data: { providers: [{ id: 'amazon-bedrock', name: 'Amazon Bedrock', models: [{ id: 'us.anthropic.claude:0', name: 'Claude Sonnet 4.5' }] }] },
    });
    const { result } = renderHook(() => useAIProviders(serverProviders, { askAgent: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.providers[0]).toMatchObject({ id: 'ask-agent', name: 'Ask agent', source: 'agent' });
    expect(result.current.selectedProvider).toBe('ask-agent');
    // Composite id keeps the real provider + a model id that itself contains ':'.
    expect(result.current.selectedModel).toBe('amazon-bedrock|us.anthropic.claude:0');
    expect(result.current.currentModels[0].name).toBe('Claude Sonnet 4.5 (Amazon Bedrock)');
    expect(result.current.currentSource).toBe('agent');
  });

  it('falls back to the direct providers when the ask service is unavailable', async () => {
    getAskProviders.mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useAIProviders(serverProviders, { askAgent: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.providers.some((p) => p.id === 'ask-agent')).toBe(false);
    expect(result.current.selectedProvider).toBe('amazon-bedrock');
  });

  it('does not query the ask service unless asked to', async () => {
    const { result } = renderHook(() => useAIProviders(serverProviders));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getAskProviders).not.toHaveBeenCalled();
  });
});

describe('streamAgentDraft', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('turns a pipeline proposal into done, passing the real provider/model', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'tool-call', data: { toolName: 'propose_pipeline' } },
      { type: 'proposal', data: { kind: 'pipeline', props: { project: 'app' }, description: 'd', keywords: ['node'] } },
      { type: 'done' },
    ]));
    const events = await collect(streamAgentDraft('pipeline', 'ci for a node app', 'amazon-bedrock|claude-sonnet'));

    expect(askAgentStream).toHaveBeenCalledWith(expect.stringContaining('ci for a node app'), { provider: 'amazon-bedrock', model: 'claude-sonnet' });
    expect(events).toEqual([
      { type: 'tool-call', data: { toolName: 'propose_pipeline' } },
      { type: 'done', data: { props: { project: 'app' }, description: 'd', keywords: ['node'] } },
    ]);
  });

  it('emits the repo analysis as analyzed before done, and forwards the repo token', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: { kind: 'pipeline', props: { project: 'app' }, analysis: { repo: 'app' } } },
    ]));
    const events = await collect(streamAgentDraft('pipeline-from-repo', 'https://github.com/o/app', 'anthropic|claude', { repoToken: 'ghp_x' }));

    expect(askAgentStream.mock.calls[0][1]).toEqual({ provider: 'anthropic', model: 'claude', repoToken: 'ghp_x' });
    expect(events.map((e) => e.type)).toEqual(['analyzed', 'done']);
    expect(events[0].data).toEqual({ repo: 'app' });
  });

  it('ignores drafts of another kind and reports what the agent said instead', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: { kind: 'template', props: {} } },
      { type: 'token', data: 'I need to know which language you use.' },
      { type: 'done' },
    ]));
    const events = await collect(streamAgentDraft('plugin', 'a build plugin', 'anthropic|claude'));

    expect(events).toEqual([{ type: 'error', message: "The Ask agent didn't draft a plugin: I need to know which language you use." }]);
  });

  it('treats an incomplete plugin draft (failed delegated generation) as no draft', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: { kind: 'plugin', config: { name: 'x' } } },
      { type: 'done' },
    ]));
    const events = await collect(streamAgentDraft('plugin', 'a build plugin', 'anthropic|claude'));
    expect(events).toEqual([{ type: 'error', message: "The Ask agent didn't draft a plugin — try rephrasing your request." }]);
  });
});
