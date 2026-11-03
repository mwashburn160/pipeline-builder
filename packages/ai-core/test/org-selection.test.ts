// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org-aware selection: request BYO key > org key > platform key, the AI switch, and
 * no silent downgrade from an org key to the platform's.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const createModelWithKey = jest.fn((provider: string, modelId: string, _key: string) => ({ provider, modelId }));
const resolveModelSelection = jest.fn((sel: { provider?: string; apiKey?: string }) => ({
  model: {}, provider: sel.provider ?? 'openai', modelId: 'm', keySource: sel.apiKey ? 'request' : 'platform',
}));
jest.unstable_mockModule('../src/provider-registry.js', () => ({
  createModelWithKey,
  resolveModelSelection,
  isKeylessProvider: (id: string) => id === 'amazon-bedrock',
}));

const { resolveOrgModelSelection } = await import('../src/org-selection.js');
const { AIDisabledError, AIConfigurationError } = await import('@pipeline-builder/api-core');

const enabled = (providers: string[]) => async () => ({ aiEnabled: true, providers });

describe('resolveOrgModelSelection', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('refuses an org that switched AI off', async () => {
    await expect(resolveOrgModelSelection({ orgId: 'o' }, { assertEnabled: async () => { throw new AIDisabledError(); } }))
      .rejects.toBeInstanceOf(AIDisabledError);
  });

  it('a bring-your-own key wins over the org key', async () => {
    const fetchKey = jest.fn(async () => 'org-key');
    const r = await resolveOrgModelSelection({ orgId: 'o', provider: 'anthropic', apiKey: 'byo' }, { assertEnabled: enabled(['anthropic']), fetchKey });
    expect(r.keySource).toBe('request');
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it('uses the org key for the named provider, and the org\'s first provider when none is named', async () => {
    const fetchKey = jest.fn(async () => 'org-key');
    const named = await resolveOrgModelSelection({ orgId: 'o', provider: 'anthropic' }, { assertEnabled: enabled(['openai', 'anthropic']), fetchKey });
    expect(named).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-5-5', keySource: 'org' });
    expect(createModelWithKey).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5-5', 'org-key');
    const unnamed = await resolveOrgModelSelection({ orgId: 'o' }, { assertEnabled: enabled(['openai']), fetchKey });
    expect(unnamed).toMatchObject({ provider: 'openai', keySource: 'org' });
  });

  it('FAILS when the org key cannot be loaded — never falls back to the platform key', async () => {
    const fetchKey = jest.fn(async () => { throw new AIConfigurationError('could not be loaded'); });
    await expect(resolveOrgModelSelection({ orgId: 'o', provider: 'anthropic' }, { assertEnabled: enabled(['anthropic']), fetchKey }))
      .rejects.toThrow('could not be loaded');
    expect(resolveModelSelection).not.toHaveBeenCalled();
  });

  it('falls to the platform key when the org has no key for the provider (or only a keyless slot)', async () => {
    const r = await resolveOrgModelSelection({ orgId: 'o', provider: 'openai' }, { assertEnabled: enabled(['anthropic', 'amazon-bedrock']), fetchKey: jest.fn(async () => 'k') });
    expect(r.keySource).toBe('platform');
    const bedrock = await resolveOrgModelSelection({ orgId: 'o' }, { assertEnabled: enabled(['amazon-bedrock']) });
    expect(bedrock.keySource).toBe('platform');
  });

  it('refuses a model without a provider', async () => {
    await expect(resolveOrgModelSelection({ orgId: 'o', model: 'x' }, { assertEnabled: enabled([]) })).rejects.toThrow('without a `provider`');
  });

  it('keeps an explicitly requested model on the org key', async () => {
    const r = await resolveOrgModelSelection({ orgId: 'o', provider: 'anthropic', model: 'claude-opus-5-5' }, { assertEnabled: enabled(['anthropic']), fetchKey: async () => 'k' });
    expect(r.modelId).toBe('claude-opus-5-5');
  });
});
