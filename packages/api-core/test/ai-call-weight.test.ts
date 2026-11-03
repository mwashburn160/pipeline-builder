// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Model-class weighting of `aiCalls` (AI_MODEL_WEIGHTS): OFF by default (every
 * model weighs 1), except the self-hosted OpenAI-compatible provider (0).
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { aiCallWeight, parseAiModelWeights } from '../src/services/ai-call-weight.js';

afterEach(() => {
  delete process.env.AI_MODEL_WEIGHTS;
});

describe('aiCallWeight', () => {
  it('weighs every hosted model 1 when AI_MODEL_WEIGHTS is unset', () => {
    expect(aiCallWeight({ provider: 'anthropic', modelId: 'claude-opus-4-1' })).toBe(1);
    expect(aiCallWeight({ provider: 'openai', modelId: 'gpt-5' })).toBe(1);
  });

  it('weighs the self-hosted OpenAI-compatible provider 0 by default', () => {
    expect(aiCallWeight({ provider: 'openai-compatible', modelId: 'qwen3' })).toBe(0);
  });

  it('matches the longest key contained in the model id, and a provider key first', () => {
    process.env.AI_MODEL_WEIGHTS = JSON.stringify({ 'opus': 3, 'sonnet': 1, 'haiku': 1, 'opus-mini': 2, 'bedrock': 5 });
    expect(aiCallWeight({ provider: 'anthropic', modelId: 'claude-opus-4-1' })).toBe(3);
    expect(aiCallWeight({ provider: 'anthropic', modelId: 'claude-opus-mini-1' })).toBe(2);
    expect(aiCallWeight({ provider: 'anthropic', modelId: 'claude-haiku-4-5' })).toBe(1);
    expect(aiCallWeight({ provider: 'bedrock', modelId: 'anthropic.claude-opus' })).toBe(5);
    expect(aiCallWeight({ provider: 'google', modelId: 'gemini-pro' })).toBe(1);
  });

  it('lets the operator meter the self-hosted provider like any other', () => {
    process.env.AI_MODEL_WEIGHTS = '{"openai-compatible": 1}';
    expect(aiCallWeight({ provider: 'openai-compatible', modelId: 'qwen3' })).toBe(1);
  });
});

describe('parseAiModelWeights', () => {
  it('ignores malformed JSON, non-objects and out-of-range entries (never fatal)', () => {
    expect(parseAiModelWeights('not json')).toEqual({ 'openai-compatible': 0 });
    expect(parseAiModelWeights('[1,2]')).toEqual({ 'openai-compatible': 0 });
    expect(parseAiModelWeights('{"opus": 3, "bad": -1, "big": 1000, "frac": 1.5, "str": "2"}')).toEqual({ 'openai-compatible': 0, 'opus': 3 });
  });
});
