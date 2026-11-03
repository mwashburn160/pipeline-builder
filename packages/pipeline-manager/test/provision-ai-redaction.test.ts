// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

// Stand in for ai-core so the prompt diagnoseFailure would send is observable.
// No `await import()` inside the factory (that deadlocks ESM mocks).
const generateText = jest.fn<AnyFn>();
const resolveModel = jest.fn<AnyFn>((provider: string, id: string) => ({ provider, id }));
const getProviderModels = jest.fn<AnyFn>(() => [{ id: 'catalog-first' }]);
jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  generateText,
  resolveModel,
  getProviderModels,
}));

const { diagnoseFailure, redactForAi } = await import('../src/agent/ai.js');

describe('redactForAi', () => {
  it('empties the account field of an ARN, keeping its segment count', () => {
    expect(redactForAi('Role arn:aws:iam::123456789012:role/deploy is invalid'))
      .toBe('Role arn:aws:iam:::role/deploy is invalid');
    expect(redactForAi('arn:aws:kms:us-east-1:123456789012:key/abc'))
      .toBe('arn:aws:kms:us-east-1::key/abc');
    expect(redactForAi('arn:aws-us-gov:sts::123456789012:assumed-role/x'))
      .toBe('arn:aws-us-gov:sts:::assumed-role/x');
  });

  it('masks a bare 12-digit account id', () => {
    expect(redactForAi('account 123456789012 lacks permission')).toBe('account [REDACTED] lacks permission');
    expect(redactForAi('(123456789012)')).toBe('([REDACTED])');
  });

  it('leaves UUIDs, timestamps and longer numbers intact', () => {
    const uuid = 'stack/pb/1a2b3c4d-1111-2222-3333-123456789012';
    expect(redactForAi(uuid)).toBe(uuid);
    expect(redactForAi('at 1730505600123 (ms) / 20261102120000')).toBe('at 1730505600123 (ms) / 20261102120000');
    expect(redactForAi('id i-0123456789012abcd')).toBe('id i-0123456789012abcd');
  });

  it('masks secret-shaped values via the shared api-core patterns', () => {
    const out = redactForAi('key AKIAIOSFODNN7EXAMPLE password=hunter22 token ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('passes empty input through', () => {
    expect(redactForAi('')).toBe('');
  });
});

describe('diagnoseFailure', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    generateText.mockReset();
    generateText.mockResolvedValue({ text: ' the role is missing ' } as never);
    resolveModel.mockClear();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
  });
  afterAll(() => {
    process.env = saved;
  });

  it('sends redacted failure text to the provider', async () => {
    await expect(diagnoseFailure(
      'CREATE_FAILED Role arn:aws:iam::123456789012:role/x in 123456789012 secret=abc123',
    )).resolves.toBe('the role is missing');
    const prompt = (generateText.mock.calls[0]?.[0] as { prompt: string }).prompt;
    expect(prompt).not.toMatch(/123456789012/);
    expect(prompt).not.toContain('abc123');
    expect(prompt).toContain('arn:aws:iam:::role/x');
  });

  it('defaults Anthropic to the current Sonnet rather than the catalog head', async () => {
    await diagnoseFailure('CREATE_FAILED');
    expect(resolveModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5-5');
  });

  it('an explicit model still wins', async () => {
    await diagnoseFailure('CREATE_FAILED', { model: 'claude-opus-5-5' });
    expect(resolveModel).toHaveBeenCalledWith('anthropic', 'claude-opus-5-5');
  });

  it('other providers fall back to their catalog head', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    await diagnoseFailure('CREATE_FAILED', { provider: 'openai' });
    expect(resolveModel).toHaveBeenCalledWith('openai', 'catalog-first');
  });
});
