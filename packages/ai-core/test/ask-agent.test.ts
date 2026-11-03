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

    const args = generateText.mock.calls[0][0] as { messages: Array<{ role: string; content: string; providerOptions?: Record<string, unknown> }> };
    const [staticSystem, context] = args.messages.filter((m) => m.role === 'system');
    // The STATIC instructions come first and are marked cacheable; the per-query
    // retrieved context is a separate system message after the cache breakpoint.
    expect(staticSystem.content).toContain('read-only assistant');
    expect(staticSystem.providerOptions?.anthropic).toEqual({ cacheControl: { type: 'ephemeral' } });
    expect(staticSystem.content).not.toContain('in-cluster Alertmanager');
    expect(context.content).toContain('in-cluster Alertmanager'); // retrieved context injected
    expect(context.providerOptions).toBeUndefined();
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
    expect(args.messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user']);
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
      { type: 'finish', totalUsage: { inputTokens: 120, outputTokens: 7 } },
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
    // The call's total usage arrives last, for accounting and the audit row.
    expect(seen[seen.length - 1]).toBe('usage');
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

describe('call settings + stream edges', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('passes temperature and retries through only when given', async () => {
    const index = buildGroundingIndex(docs);
    await answerHowTo({ model: fakeModel, query: 'stripe', index, temperature: 0.2, maxRetries: 1, maxOutputTokens: 100 });
    expect(generateText.mock.calls[0][0]).toMatchObject({ temperature: 0.2, maxRetries: 1, maxOutputTokens: 100 });
    await answerHowTo({ model: fakeModel, query: 'stripe', index });
    expect(generateText.mock.calls[1][0]).not.toHaveProperty('temperature');
  });

  it('ignores an empty delta and a finish without usage; wraps a non-Error failure', async () => {
    streamParts = [{ type: 'start-step' }, { type: 'text-delta', delta: '' }, { type: 'finish' }];
    const index = buildGroundingIndex(docs);
    const seen: string[] = [];
    for await (const e of streamHowTo({ model: fakeModel, query: 'stripe', index }).events) seen.push(e.type);
    expect(seen).toEqual(['provider-responded']);
    streamParts = [{ type: 'error', error: 'plain string' }];
    await expect((async () => { for await (const _ of streamHowTo({ model: fakeModel, query: 'stripe', index }).events) { /* drain */ } })())
      .rejects.toThrow('plain string');
  });
});
