// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds wait out the registry's weekly blob-GC push freeze instead of being
 * refused at their push. The freeze (image-registry, 300 s tokens) runs Sunday
 * 03:04:00–03:40:00 UTC; a build is held from 30 minutes before it.
 */

import { describe, expect, it } from '@jest/globals';
import { pushFreezeActiveAt } from '@pipeline-builder/api-core';

import { BUILD_PUSH_LEAD_MS, blobGcHoldUntil, HOLD_JITTER_MS } from '../src/queue/blob-gc-hold.js';

const at = (iso: string) => Date.parse(iso);
const FREEZE_END = at('2026-11-22T03:40:00Z');
const noJitter = () => 0;

describe('blobGcHoldUntil', () => {
  it.each([
    ['2026-11-22T02:33:59Z', null], // more than a build's length before the freeze
    ['2026-11-22T02:34:00Z', FREEZE_END], // 30 min before 03:04
    ['2026-11-22T03:20:00Z', FREEZE_END], // mid-GC
    ['2026-11-22T03:39:59Z', FREEZE_END],
    ['2026-11-22T03:40:00Z', null], // the freeze is over
    ['2026-11-21T03:20:00Z', null], // Saturday
    ['2026-11-25T12:00:00Z', null], // midweek
  ])('%s → %s', (iso, expected) => {
    expect(blobGcHoldUntil(at(iso), noJitter)).toBe(expected);
  });

  it('releases held builds no earlier than the freeze end, spread over the jitter window', () => {
    const until = blobGcHoldUntil(at('2026-11-22T03:20:00Z'), () => 0.999)!;
    expect(until).toBeGreaterThanOrEqual(FREEZE_END);
    expect(until).toBeLessThan(FREEZE_END + HOLD_JITTER_MS);
    expect(pushFreezeActiveAt(until, 300)).toBe(false);
  });

  it('holds every build that would start its push inside the freeze', () => {
    // A build picked up just outside the hold reaches the freeze no sooner than the lead.
    const lastFree = at('2026-11-22T02:33:59Z');
    expect(pushFreezeActiveAt(lastFree + BUILD_PUSH_LEAD_MS - 1000, 300)).toBe(false);
  });
});
