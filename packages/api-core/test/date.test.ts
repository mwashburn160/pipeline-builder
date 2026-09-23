// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { isoOrNull } from '../src/utils/date.js';

describe('isoOrNull', () => {
  it('serializes a Date', () => {
    expect(isoOrNull(new Date('2026-09-23T10:11:12.000Z'))).toBe('2026-09-23T10:11:12.000Z');
  });

  it('normalizes a string the driver handed back instead of a Date', () => {
    // The reason this goes through `new Date(d)` rather than `d.toISOString()`:
    // Mongo aggregation output, a `::text` cast and a rehydrated cache row all
    // arrive as strings, and the naive form throws on them.
    expect(isoOrNull('2026-09-23T10:11:12Z')).toBe('2026-09-23T10:11:12.000Z');
  });

  it('accepts epoch millis', () => {
    expect(isoOrNull(1_758_621_072_000)).toBe('2025-09-23T09:51:12.000Z');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['epoch zero (means "unset" in this codebase, never 1970)', 0],
  ])('returns null for %s', (_label, input) => {
    expect(isoOrNull(input as Date | string | number | null | undefined)).toBeNull();
  });

  it('throws on an unparseable timestamp rather than serving a plausible null', () => {
    expect(() => isoOrNull('not-a-date')).toThrow(RangeError);
  });
});
