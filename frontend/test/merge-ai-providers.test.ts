// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** mergeAIProviders: the AI picker's provider order and sources. */

import { describe, it, expect } from '@jest/globals';
import { mergeAIProviders, pickDefaultProvider } from '@/hooks/useAIProviders';

const server = { data: { providers: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] }] } };
const org = { success: true, statusCode: 200, data: { providers: { anthropic: { configured: true }, openai: { configured: true }, google: { configured: false } } } } as never;
/** An Ask agent on a CLOUD provider: never "Local model". */
const ask = { data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude', name: 'Claude' }] }] } };
/** An Ask agent on the self-hosted provider. */
const askLocal = { data: { providers: [{ id: 'openai-compatible', name: 'Local model (OpenAI-compatible)', models: [{ id: 'qwen', name: 'Qwen' }] }] } };
/** The self-hosted Ask agent offered and answering its availability check. */
const answering = { agent: askLocal, agentAnswering: true };

describe('mergeAIProviders', () => {
  it('leads with Local model (routed via the agent), then configured (the org key wins over the server\'s), then the rest alphabetically', () => {
    const merged = mergeAIProviders(server, org, answering);
    // openai is configured on BOTH: the backend serves it on the org's key
    // (caller key > org key > platform key), so it is labelled `org`.
    expect(merged.map((p) => `${p.id}:${p.source}`)).toEqual([
      'ask-agent:local',
      'anthropic:org',
      'openai:org',
      'amazon-bedrock:none',
      'google:none',
      'xai:none',
    ]);
    expect(merged[0]!.name).toBe('Local model');
    expect(merged[0]!.models[0]!.id).toBe('openai-compatible|qwen');
  });

  it('keeps a server-only provider labelled `server`', () => {
    const orgAnthropicOnly = { success: true, statusCode: 200, data: { providers: { anthropic: { configured: true } } } } as never;
    expect(mergeAIProviders(server, orgAnthropicOnly).find((p) => p.id === 'openai')!.source).toBe('server');
  });

  it('never labels a keyless provider `org` — the backend serves it on the platform role, not an org key', () => {
    const orgBedrock = { success: true, statusCode: 200, data: { providers: { 'amazon-bedrock': { configured: true } } } } as never;
    expect(mergeAIProviders(null, orgBedrock).find((p) => p.id === 'amazon-bedrock')!.source).toBe('none');
  });

  it('lists the whole catalog as unconfigured when every source failed', () => {
    const merged = mergeAIProviders(null, null);
    expect(merged.every((p) => p.source === 'none')).toBe(true);
    expect(merged).toHaveLength(5);
  });

  it('omits Local model when the ask-agent service reports no models and no local provider is configured', () => {
    expect(mergeAIProviders(null, null, { agent: { data: { providers: [] } }, agentAnswering: true }).some((p) => p.source === 'local')).toBe(false);
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
    const merged = mergeAIProviders(server, null);
    // Bedrock is in the list, and ahead of everything else unconfigured.
    expect(merged.some((p) => p.id === 'amazon-bedrock' && p.source === 'none')).toBe(true);
    expect(pickDefaultProvider(merged)!.id).toBe('openai');
  });

  it('prefers Local model when it is available', () => {
    expect(pickDefaultProvider(mergeAIProviders(server, org, answering))!.source).toBe('local');
  });

  it('skips a configured provider that has no models, since it cannot be selected', () => {
    const modelless = { data: { providers: [{ id: 'openai', name: 'OpenAI', models: [] }] } };
    const merged = mergeAIProviders(modelless, org);
    const picked = pickDefaultProvider(merged)!;
    expect(picked.source).not.toBe('none');
    expect(picked.models.length).toBeGreaterThan(0);
  });

  it('still returns something when nothing is configured, so the picker is never empty', () => {
    // The panel blocks sending in this state and says so; the selection itself
    // only has to be non-empty so the control renders.
    const merged = mergeAIProviders(null, null);
    expect(merged.every((p) => p.source === 'none')).toBe(true);
    expect(pickDefaultProvider(merged)).toBeDefined();
  });
});

/**
 * The single "Local model" option: the Ask agent and the local OpenAI-compatible
 * provider folded into one entry whose id names the route it takes.
 */
describe('mergeAIProviders: the combined Local model option', () => {
  const local = { data: { providers: [
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }] },
    { id: 'openai-compatible', name: 'Local model (OpenAI-compatible)', models: [{ id: 'qwen', name: 'Qwen' }] },
  ] } };
  const agentLocal = { data: { providers: [{ id: 'openai-compatible', name: 'Local model (OpenAI-compatible)', models: [{ id: 'qwen', name: 'Qwen' }] }] } };
  const locals = (merged: ReturnType<typeof mergeAIProviders>) => merged.filter((p) => p.source === 'local' || p.id === 'openai-compatible' || p.id === 'ask-agent');

  it('routes via the agent (agent models, composite ids) when the agent answers', () => {
    const merged = mergeAIProviders(local, null, { agent: agentLocal, agentAnswering: true });
    expect(locals(merged)).toEqual([
      { id: 'ask-agent', name: 'Local model', source: 'local', models: [{ id: 'openai-compatible|qwen', name: 'Qwen' }] },
    ]);
    expect(merged[0]!.id).toBe('ask-agent');
    expect(pickDefaultProvider(merged)!.id).toBe('ask-agent');
  });

  it('routes straight to the local provider (its own models) when the agent is not answering', () => {
    const merged = mergeAIProviders(local, null, { agent: agentLocal, agentAnswering: false });
    expect(locals(merged)).toEqual([{ id: 'openai-compatible', name: 'Local model', source: 'local', models: [{ id: 'qwen', name: 'Qwen' }] }]);
    expect(pickDefaultProvider(merged)!.id).toBe('openai-compatible');
  });

  it('routes straight to the local provider when the Ask agent is not offered at all', () => {
    const merged = mergeAIProviders(local, null, { agent: null, agentAnswering: false });
    expect(locals(merged)).toEqual([{ id: 'openai-compatible', name: 'Local model', source: 'local', models: [{ id: 'qwen', name: 'Qwen' }] }]);
  });

  it('is listed but unavailable, and never the default, when neither path can serve', () => {
    const merged = mergeAIProviders(server, null, { agent: askLocal, agentAnswering: false });
    const entry = merged.find((p) => p.source === 'local')!;
    expect(entry).toMatchObject({ id: 'ask-agent', name: 'Local model', unavailable: true });
    expect(pickDefaultProvider(merged)!.id).toBe('openai');
  });

  it('is never selected when unavailable, even when nothing else is configured', () => {
    const picked = pickDefaultProvider(mergeAIProviders(null, null, { agent: askLocal, agentAnswering: false }))!;
    expect(picked.source).toBe('none');
  });

  it('never routes via an Ask agent on a cloud provider: no Local model without a self-hosted route', () => {
    const merged = mergeAIProviders(server, null, { agent: ask, agentAnswering: true });
    expect(merged.some((p) => p.source === 'local' || p.id === 'ask-agent')).toBe(false);
    expect(merged.flatMap((p) => p.models).some((m) => m.id === 'anthropic|claude')).toBe(false);
  });

  it('uses the direct local route when the Ask agent is on a cloud provider', () => {
    const merged = mergeAIProviders(local, null, { agent: ask, agentAnswering: true });
    expect(locals(merged)).toEqual([{ id: 'openai-compatible', name: 'Local model', source: 'local', models: [{ id: 'qwen', name: 'Qwen' }] }]);
  });

  it('keeps only the agent\'s self-hosted models when it also has cloud ones', () => {
    const mixed = { data: { providers: [...ask.data.providers, ...askLocal.data.providers] } };
    const entry = mergeAIProviders(null, null, { agent: mixed, agentAnswering: true }).find((p) => p.source === 'local')!;
    expect(entry).toMatchObject({ id: 'ask-agent', models: [{ id: 'openai-compatible|qwen', name: 'Qwen' }] });
  });

  it('leaves the provider list alone when the combined option was not asked for (the Ask panel)', () => {
    const merged = mergeAIProviders(local, null);
    expect(merged.find((p) => p.id === 'openai-compatible')).toMatchObject({ name: 'Local model (OpenAI-compatible)', source: 'server' });
    expect(merged.some((p) => p.source === 'local')).toBe(false);
  });
});
