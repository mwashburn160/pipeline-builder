// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How an AI failure reads to the user (`formatAIError`), and the "answered by"
 * footer (`AIServedBy`) shown under generation results and Ask answers.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { ApiError, QuotaExceededError } from '../src/lib/api/errors';
import { AI_DISABLED_MESSAGE, formatAIError, isAIDisabledError, streamEventError } from '../src/lib/ai-errors';
import { AIDisabledNotice, AIServedBy } from '../src/components/ui/AIServedBy';

const withRetry = (status: number, message: string, retryAfter?: number) => {
  const e = new ApiError(message, status, status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'SERVICE_UNAVAILABLE');
  if (retryAfter !== undefined) e.retryAfter = retryAfter;
  return e;
};

describe('formatAIError', () => {
  it('says AI is turned off for an AI_DISABLED refusal', () => {
    const err = new ApiError('AI features are turned off', 403, 'AI_DISABLED');
    expect(isAIDisabledError(err)).toBe(true);
    expect(formatAIError(err, 'x')).toBe(AI_DISABLED_MESSAGE);
  });

  it('tells the user how long a busy provider asked them to wait', () => {
    expect(formatAIError(withRetry(429, 'The AI provider is rate limiting requests. Try again shortly.', 12), 'x'))
      .toBe('The AI provider is rate limiting requests. Retry in 12 s.');
    expect(formatAIError(withRetry(503, 'The AI provider is temporarily unavailable. Try again shortly.', 30), 'x'))
      .toBe('The AI provider is temporarily unavailable. Retry in 30 s.');
  });

  it('still says to retry when the provider sent no Retry-After', () => {
    expect(formatAIError(withRetry(503, 'The AI provider is temporarily unavailable. Try again shortly.'), 'x'))
      .toBe('The AI provider is temporarily unavailable. Try again in a moment.');
  });

  it('leaves a quota refusal to the global notice — its own sentence, untouched', () => {
    const quota = new QuotaExceededError('AI call quota reached (10/10); resets 2026-11-05.', {});
    expect(formatAIError(quota, 'x')).toBe('AI call quota reached (10/10); resets 2026-11-05.');
  });

  it('falls back to the server message, then the fallback', () => {
    expect(formatAIError(new ApiError('The AI provider did not respond in time.', 504), 'x')).toBe('The AI provider did not respond in time.');
    expect(formatAIError(undefined, 'Generation failed')).toBe('Generation failed');
  });
});

describe('streamEventError', () => {
  it('turns an SSE error frame into the same error an HTTP failure would be', () => {
    const err = streamEventError({ type: 'error', message: 'The AI provider is rate limiting requests. Try again shortly.', code: 'RATE_LIMIT_EXCEEDED', status: 429, retryAfterSeconds: 7 });
    expect(err).toBeInstanceOf(ApiError);
    expect(formatAIError(err, 'x')).toBe('The AI provider is rate limiting requests. Retry in 7 s.');
    expect(formatAIError(streamEventError({ type: 'error', message: 'off', code: 'AI_DISABLED', status: 403 }), 'x')).toBe(AI_DISABLED_MESSAGE);
  });
});

describe('AIServedBy', () => {
  it('names the model and provider that ANSWERED, any failover, and the token cost', () => {
    render(<AIServedBy
      servedBy={{ provider: 'anthropic', model: 'claude-sonnet-5-5', fallbackFrom: 'openai' }}
      usage={{ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000 }}
    />);
    const line = screen.getByTestId('ai-served-by').textContent ?? '';
    expect(line).toContain('Claude Sonnet 5.5 (Anthropic)');
    expect(line).toContain('OpenAI was unavailable, so it failed over');
    expect(line).toContain('1,500 tokens (1,000 cached)');
  });

  it('renders nothing when the response carried no servedBy', () => {
    const { container } = render(<AIServedBy servedBy={undefined} usage={{ inputTokens: 1, outputTokens: 1 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the disabled notice says AI is off and who can turn it back on', () => {
    render(<AIDisabledNotice />);
    expect(screen.getByTestId('ai-disabled-notice')).toHaveTextContent(/turned off for this organization/i);
    expect(screen.getByTestId('ai-disabled-notice')).toHaveTextContent(/administrator/i);
  });
});
