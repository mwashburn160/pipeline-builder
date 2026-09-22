// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** mergeAIProviders: the AI picker's provider order and sources. */

import { describe, it, expect } from '@jest/globals';
import { mergeAIProviders } from '@/hooks/useAIProviders';

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
