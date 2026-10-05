// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** mergeAIProviders: the AI picker's provider order and sources. */

import { describe, it, expect } from '@jest/globals';
import { mergeAIProviders, pickDefaultProvider } from '@/hooks/useAIProviders';

const server = { data: { providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] }] } };
const org = { success: true, statusCode: 200, data: { providers: { anthropic: { configured: true }, openai: { configured: true }, google: { configured: false } } } } as never;
const ask = { data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude', name: 'Claude' }] }] } };

describe('mergeAIProviders', () => {
  it('leads with Ask agent, then configured (server wins over org), then the rest alphabetically', () => {
    const merged = mergeAIProviders(server, org, ask);
    expect(merged.map((p) => `${p.id}:${p.source}`)).toEqual([
      'ask-agent:agent',
      'anthropic:org',
      'openai:server',
      'amazon-bedrock:none',
      'google:none',
      'xai:none',
    ]);
    expect(merged[0]!.models[0]!.name).toBe('Claude (Anthropic)');
  });

  it('lists the whole catalog as unconfigured when every source failed', () => {
    const merged = mergeAIProviders(null, null, null);
    expect(merged.every((p) => p.source === 'none')).toBe(true);
    expect(merged).toHaveLength(5);
  });

  it('omits Ask agent when the ask service reports no models', () => {
    expect(mergeAIProviders(null, null, { data: { providers: [] } }).some((p) => p.id === 'ask-agent')).toBe(false);
  });
});

/**
 * Which provider the picker starts on.
 *
 * The bug this pins was invisible in the UI: something was always selected, so
 * nothing looked wrong until a turn was sent and the backend answered
 * `AI provider "amazon-bedrock" is not configured`. The catalog pads the list
 * with every known provider at `source: 'none'`, sorted by display name, and
 * "Amazon Bedrock" sorts ahead of Anthropic, Google, OpenAI and xAI — so on a
 * deployment with nothing configured, taking `merged[0]` named a vendor the
 * user had never chosen for a problem that was not vendor-specific.
 */
describe('pickDefaultProvider', () => {
  it('skips unconfigured providers that merely sort first', () => {
    const merged = mergeAIProviders(server, null, null);
    // Bedrock is in the list, and ahead of everything else unconfigured.
    expect(merged.some((p) => p.id === 'amazon-bedrock' && p.source === 'none')).toBe(true);
    expect(pickDefaultProvider(merged)!.id).toBe('openai');
  });

  it('prefers the Ask agent when it is available', () => {
    expect(pickDefaultProvider(mergeAIProviders(server, org, ask))!.id).toBe('ask-agent');
  });

  it('skips a configured provider that has no models, since it cannot be selected', () => {
    const modelless = { data: { providers: [{ id: 'openai', name: 'OpenAI', models: [] }] } };
    const merged = mergeAIProviders(modelless, org, null);
    const picked = pickDefaultProvider(merged)!;
    expect(picked.source).not.toBe('none');
    expect(picked.models.length).toBeGreaterThan(0);
  });

  it('still returns something when nothing is configured, so the picker is never empty', () => {
    // The panel blocks sending in this state and says so; the selection itself
    // only has to be non-empty so the control renders.
    const merged = mergeAIProviders(null, null, null);
    expect(merged.every((p) => p.source === 'none')).toBe(true);
    expect(pickDefaultProvider(merged)).toBeDefined();
  });
});
