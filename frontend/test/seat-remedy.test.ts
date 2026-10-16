// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The frontend's seat-remedy helpers (src/lib/tiers.ts) mirror api-core's, which
 * the billing catalog uses to decide who may buy a seat. If the two lists drift,
 * the UI offers a seat pack billing will not sell (or hides one it will).
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from '@jest/globals';
import { SEAT_PACK_TIERS, seatRemedy, seatRemedyLabel, seatsAtCapacity } from '../src/lib/tiers';

/**
 * api-core's list, read from its SOURCE: importing the package at runtime pulls
 * in server-only modules (express) that do not load under jsdom.
 */
function coreSeatPackTiers(): string[] {
  const src = readFileSync(path.join(__dirname, '../../packages/api-core/src/types/quota-tiers.ts'), 'utf8');
  const m = /export const SEAT_PACK_TIERS[^=]*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) throw new Error('SEAT_PACK_TIERS not found in api-core quota-tiers.ts');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

describe('seat remedy — frontend mirror of api-core', () => {
  it('offers seat packs on exactly the tiers billing sells them to', () => {
    const core = coreSeatPackTiers();
    expect(core.length).toBeGreaterThan(0); // guards an empty parse
    expect([...SEAT_PACK_TIERS].sort()).toEqual(core.sort());
  });

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
