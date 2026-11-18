// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ask-agent service refuses a `history` over 20 turns, 8000 characters a turn, or
 * 32,000 in all (a 400) — so without bounding, every question after a long
 * enough conversation failed. `boundAskHistory` keeps the NEWEST turns that fit.
 */

import { describe, it, expect } from '@jest/globals';
import type { AskTurn } from '../src/lib/api/domains/ask';
import { boundAskHistory } from '../src/lib/ask-history';

const turn = (i: number, len = 10): AskTurn => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: String(i).padEnd(len, 'x') });

describe('boundAskHistory', () => {
  it('passes a short conversation through unchanged', () => {
    const h = [turn(0), turn(1)];
    expect(boundAskHistory(h)).toEqual(h);
  });

  it('keeps only the newest 20 turns', () => {
    const h = Array.from({ length: 30 }, (_, i) => turn(i));
    const out = boundAskHistory(h);
    expect(out).toHaveLength(20);
    expect(out[0]).toEqual(h[10]);
    expect(out[19]).toEqual(h[29]);
  });

  it('caps a single turn at 8000 characters', () => {
    const out = boundAskHistory([turn(0, 9000)]);
    expect(out[0].content).toHaveLength(8000);
  });

  it('drops the oldest turns once the total would pass 32,000 characters', () => {
    const h = Array.from({ length: 6 }, (_, i) => turn(i, 7000));
    const out = boundAskHistory(h);
    expect(out.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(32_000);
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual(h[5]);
  });
});
