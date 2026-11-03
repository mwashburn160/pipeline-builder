// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ask request bounds that size one aiCalls unit: the client-held history is
 * resent as model input on every turn, so its TOTAL is capped, not just each
 * message.
 */

import { describe, it, expect } from '@jest/globals';
import { AskBodySchema, AskFeedbackSchema, MAX_HISTORY_CHARS } from '../src/request-schema.js';

const msgs = (n: number, len: number) => Array.from({ length: n }, () => ({ role: 'user' as const, content: 'x'.repeat(len) }));

describe('AskBodySchema history', () => {
  it('accepts a history up to the total cap', () => {
    expect(AskBodySchema.safeParse({ query: 'q', history: msgs(4, MAX_HISTORY_CHARS / 4) }).success).toBe(true);
  });

  it('refuses a history whose messages each fit but whose total does not', () => {
    const r = AskBodySchema.safeParse({ query: 'q', history: msgs(5, 7_000) });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(`${MAX_HISTORY_CHARS}`);
  });
});

describe('AskFeedbackSchema', () => {
  it('requires a rating for an answer, not for a search miss', () => {
    expect(AskFeedbackSchema.safeParse({ kind: 'answer' }).success).toBe(false);
    expect(AskFeedbackSchema.safeParse({ kind: 'answer', rating: 'up' }).success).toBe(true);
    expect(AskFeedbackSchema.safeParse({ kind: 'help-search-miss' }).success).toBe(true);
  });
});
