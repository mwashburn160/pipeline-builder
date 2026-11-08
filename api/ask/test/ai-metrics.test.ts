// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI/ask metric emitters, and the label sets they are allowed to carry.
 *
 * These were the least-covered functions in the service (branches 37.5%,
 * functions 50%) — two of the three were never called by a test. They are one
 * line each, so the point of testing them is NOT the line: it is the LABEL
 * CARDINALITY the module documents and nothing enforced.
 *
 * Each of these files' comments says what must stay out: the WHICH of a rated
 * answer ("a Prometheus label per doc would multiply the series by the size of
 * the corpus") and a help search's query text ("user-entered text this service
 * deliberately never records"). A label added later breaks neither a type nor a
 * test — it just multiplies the series count in production, which is a
 * cardinality incident found by the monitoring bill. So the label KEYS are
 * pinned here, and a new one has to be a deliberate edit to this list.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

const incCounter = jest.fn<(name: string, labels?: Record<string, string>, value?: number) => void>();
const observe = jest.fn<(name: string, labels: Record<string, string>, value: number) => void>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter,
  observe,
  setGauge: jest.fn(),
}));

const { recordAi, recordAiTokens, recordAskFeedback, recordHelpSearchMiss } = await import('../src/services/ai-metrics.js');

/** The labels a metric was emitted with, by series kind. */
const emitted = (name: string) => incCounter.mock.calls.filter((c) => c[0] === name);
const labelKeys = (labels: Record<string, string> | undefined) => Object.keys(labels ?? {}).sort();

beforeEach(() => { incCounter.mockClear(); observe.mockClear(); });

describe('recordAiTokens', () => {
  const served = { provider: 'anthropic', keySource: 'platform', tier: 'pro' };

  it('emits input and output series with a fixed label set', () => {
    recordAiTokens('ask', served, { inputTokens: 120, outputTokens: 45, cachedInputTokens: 0 });
    const calls = emitted('ai_tokens_total');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // route/provider/key_source/tier/kind and NOTHING else. Each of these is
      // bounded; anything per-user, per-org or per-prompt is not.
      expect(labelKeys(call[1])).toEqual(['key_source', 'kind', 'provider', 'route', 'tier']);
    }
    expect(calls.map((c) => c[1]?.kind)).toEqual(['input', 'output']);
    expect(calls.map((c) => c[2])).toEqual([120, 45]);
  });

  it('emits the cached_input series ONLY when there were cached tokens', () => {
    // The one branch in this file. A zero-valued third series on every call
    // would be noise in every dashboard that sums by kind.
    recordAiTokens('ask', served, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    expect(emitted('ai_tokens_total').map((c) => c[1]?.kind)).toEqual(['input', 'output']);

    incCounter.mockClear();
    recordAiTokens('ask', served, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 77 });
    const kinds = emitted('ai_tokens_total').map((c) => c[1]?.kind);
    expect(kinds).toEqual(['input', 'output', 'cached_input']);
    expect(emitted('ai_tokens_total')[2]?.[2]).toBe(77);
  });

  it('labels an unresolved provider rather than omitting the label', () => {
    // An absent label and a label reading "unresolved" are different series.
    // Omitting it would make the two shapes un-summable in one query.
    recordAiTokens('agent', {}, { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 });
    expect(emitted('ai_tokens_total')[0]?.[1]).toMatchObject({
      provider: 'unresolved', key_source: 'unknown', route: 'agent',
    });
  });
});

describe('recordAskFeedback', () => {
  it.each([
    ['up', true],
    ['down', false],
  ] as const)('records %s/%s as two bounded labels', (rating, grounded) => {
    recordAskFeedback(rating, grounded);
    const [call] = emitted('ask_feedback_total');
    expect(call?.[1]).toEqual({ rating, grounded: String(grounded) });
  });

  it('carries NO label identifying the answer or its documents', () => {
    // The documented rule: which docs were cited goes to the audit trail, where
    // it can be queried per organization, not into a Prometheus label.
    recordAskFeedback('up', true);
    expect(labelKeys(emitted('ask_feedback_total')[0]?.[1])).toEqual(['grounded', 'rating']);
  });
});

describe('recordHelpSearchMiss', () => {
  it('is a count with no labels at all', () => {
    // Deliberately no query text: it is user-entered, and the rate alone is the
    // signal that the corpus has drifted from what people ask.
    recordHelpSearchMiss();
    const [call] = emitted('help_search_miss_total');
    expect(call?.[0]).toBe('help_search_miss_total');
    expect(labelKeys(call?.[1])).toEqual([]);
  });
});

describe('recordAi', () => {
  it('times only a SUCCESSFUL turn', () => {
    // A failed or aborted turn's elapsed time is not a generation latency — it
    // is how long the failure took, and mixing the two makes the p99 meaningless.
    recordAi('ask', { provider: 'anthropic', model: 'claude' }, 'success', Date.now() - 1500);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toBe('ai_generation_duration_seconds');

    for (const outcome of ['error', 'aborted'] as const) {
      observe.mockClear();
      recordAi('ask', { provider: 'anthropic', model: 'claude' }, outcome, Date.now() - 1500);
      expect({ outcome, timed: observe.mock.calls.length }).toEqual({ outcome, timed: 0 });
    }
  });

  it('counts every outcome, so a brownout is visible as a ratio', () => {
    for (const outcome of ['success', 'error', 'aborted'] as const) {
      recordAi('agent', { provider: 'openai', model: 'gpt' }, outcome, Date.now());
    }
    expect(emitted('ai_requests_total').map((c) => c[1]?.outcome)).toEqual(['success', 'error', 'aborted']);
  });

  it('labels an unresolved provider and model rather than omitting them', () => {
    // Both fall back: a turn that failed BEFORE model selection still has to
    // land in the same series shape, or the error rate silently excludes the
    // failures that never got as far as choosing a model.
    recordAi('ask', {}, 'error', Date.now());
    expect(emitted('ai_requests_total')[0]?.[1]).toEqual({
      route: 'ask', provider: 'unresolved', model: 'unresolved', outcome: 'error',
    });
  });
});
