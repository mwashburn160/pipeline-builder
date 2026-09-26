// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `percentile` must agree with Postgres's `PERCENTILE_CONT`, because a reader
 * cross-checking a DORA tail against a hand-written SQL query has to get the same
 * number. Linear interpolation between order statistics is that definition.
 */

import { describe, it, expect } from '@jest/globals';
import { median, percentile } from '../src/api/reporting/dora-scoring.js';

describe('percentile', () => {
  it('is null for an empty sample', () => {
    expect(percentile([], 95)).toBeNull();
  });

  it('is the value itself for a single-element sample', () => {
    // Every tail of one observation is that observation — not undefined, and not 0.
    expect(percentile([42], 90)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('interpolates between order statistics, like PERCENTILE_CONT', () => {
    // rank = 0.9 * (2-1) = 0.9 ⇒ 600 + (3600-600)*0.9
    expect(percentile([600, 3600], 90)).toBe(3300);
    expect(percentile([600, 3600], 95)).toBe(3450);
  });

  it('agrees with median at p50', () => {
    for (const sample of [[1], [1, 2], [1, 2, 3], [5, 1, 4, 2, 3]]) {
      expect([sample, percentile(sample, 50)]).toEqual([sample, median(sample)]);
    }
  });

  it('does not mutate the caller\'s sample', () => {
    const sample = [3, 1, 2];
    percentile(sample, 90);
    expect(sample).toEqual([3, 1, 2]);
  });

  it('returns the maximum at p100 and the minimum at p0', () => {
    expect(percentile([10, 20, 30], 100)).toBe(30);
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });

  it('is unaffected by input order', () => {
    expect(percentile([3600, 600], 90)).toBe(percentile([600, 3600], 90));
  });
});
