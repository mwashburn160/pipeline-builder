// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Seat remedies as the UI offers them. `seatRemedy` is api-core's own (the
 * billing catalog decides who may buy a seat with the same function), imported
 * from the browser-safe `tier-limits` subpath; the wording and the capacity
 * check are the frontend's.
 */

import { describe, it, expect } from '@jest/globals';
import { seatRemedy } from '@pipeline-builder/api-core/tier-limits';
import { seatRemedyLabel, seatsAtCapacity } from '../src/lib/tiers';

describe('seat remedy', () => {
  it('seat packs on Team+, an upgrade on the single-seat tiers, nothing when uncapped or unknown', () => {
    expect(seatRemedy('team')).toBe('seat_pack');
    expect(seatRemedy('enterprise')).toBe('seat_pack');
    expect(seatRemedy('developer')).toBe('upgrade');
    expect(seatRemedy('pro')).toBe('upgrade');
    expect(seatRemedy('unlimited')).toBeNull();
    expect(seatRemedy('bogus')).toBeNull();
    expect(seatRemedy(undefined)).toBeNull();
  });
});

describe('seat helpers', () => {
  it('names the remedy in the user\'s words', () => {
    expect(seatRemedyLabel('upgrade')).toBe('upgrade to Team');
    expect(seatRemedyLabel('seat_pack')).toBe('add a seat pack');
    expect(seatRemedyLabel(null)).toBeNull();
  });

  it('is at capacity only when a capped account has used every seat', () => {
    expect(seatsAtCapacity({ used: 1, limit: 1 })).toBe(true);
    expect(seatsAtCapacity({ used: 2, limit: 1 })).toBe(true); // over cap (e.g. after a downgrade)
    expect(seatsAtCapacity({ used: 0, limit: 1 })).toBe(false);
    expect(seatsAtCapacity({ used: 50, limit: -1 })).toBe(false); // unlimited
    expect(seatsAtCapacity(null)).toBe(false);
  });
});
