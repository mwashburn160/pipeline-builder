// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock the AI SDK so no model is actually called — capture the messages the agent
// builds and assert the retrieved context is injected.

const generateText = jest.fn(async (_args: unknown) => ({ text: 'grounded answer' }));
let streamParts: Array<Record<string, unknown>> = [];
const streamText = jest.fn((_args: unknown) => ({
  fullStream: (async function* () { for (const p of streamParts) yield p; })(),
}));

jest.unstable_mockModule('ai', () => ({ generateText, streamText }));

const { buildGroundingIndex } = await import('../src/grounding.js');
const { answerHowTo, streamHowTo, buildGroundingContext } = await import('../src/ask-agent.js');

const fakeModel = { provider: 'test', modelId: 'test' } as never;

const docs = [
  { id: 'deployment.md#alertmanager', title: 'Alertmanager', url: '/docs/deployment', text: 'Alertmanager: point your incident tooling at the in-cluster Alertmanager and use the pb-incidents receiver.' },
  { id: 'billing.md#stripe', title: 'Stripe', text: 'Stripe subscription plans and add-on bundles.' },
];

describe('buildGroundingContext', () => {
  it('labels each retrieved source with its title and id', () => {
    const index = buildGroundingIndex(docs);
    const ctx = buildGroundingContext(index.search('alertmanager incident tooling'));
    expect(ctx).toContain('Source 1: Alertmanager [deployment.md#alertmanager]');
    expect(ctx).toContain('in-cluster Alertmanager');
  });

  it('handles no matches', () => {
    expect(buildGroundingContext([])).toBe('(no matching documentation found)');
  });
});

describe('answerHowTo', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('injects retrieved docs into the system message and returns sources', async () => {
    const index = buildGroundingIndex(docs);
    const res = await answerHowTo({ model: fakeModel, query: 'how do I wire alertmanager for incidents', index });

    expect(res.text).toBe('grounded answer');
    // grounded on the alertmanager chunk
    expect(res.sources[0].id).toBe('deployment.md#alertmanager');

    const args = generateText.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const system = args.messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('read-only assistant');
    expect(system.content).toContain('in-cluster Alertmanager'); // retrieved context injected
    expect(args.messages[args.messages.length - 1]).toEqual({ role: 'user', content: 'how do I wire alertmanager for incidents' });
  });

  it('threads prior history between the system grounding and the new question', async () => {
    const index = buildGroundingIndex(docs);
    await answerHowTo({
      model: fakeModel,
      query: 'and for stripe?',
      index,
      history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
    });
    const args = generateText.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(args.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

describe('streamHowTo', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns sources immediately, then provider-responded and the text', async () => {
    streamParts = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'grounded ' },
      { type: 'text-delta', id: 't', delta: 'answer' },
      { type: 'text-end', id: 't' },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const index = buildGroundingIndex(docs);
    const { sources, events } = streamHowTo({ model: fakeModel, query: 'alertmanager incidents', index });

    expect(sources[0].id).toBe('deployment.md#alertmanager');
    const seen: string[] = [];
    let out = '';
    for await (const e of events) {
      seen.push(e.type);
      if (e.type === 'text') out += e.text;
    }
    expect(out).toBe('grounded answer');
    expect(seen[0]).toBe('provider-responded');
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it('THROWS a provider error instead of ending as an empty answer', async () => {
    // A failed provider call: `start` then a bare `error`, no `start-step`.
    streamParts = [{ type: 'start' }, { type: 'error', error: new Error('invalid api key') }];
    const index = buildGroundingIndex(docs);
    const { events } = streamHowTo({ model: fakeModel, query: 'alertmanager incidents', index });

    const seen: string[] = [];
    await expect((async () => { for await (const e of events) seen.push(e.type); })()).rejects.toThrow('invalid api key');
    expect(seen).not.toContain('provider-responded');
  });
});
