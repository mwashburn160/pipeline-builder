// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The push freeze around the weekly blob GC (Sunday 03:10 UTC, 25 min run).
 * It must cover the whole run PLUS the token TTL before it — a push token
 * issued just before the freeze must expire before `garbage-collect` starts —
 * and must not leak into the rest of the week.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { OUTSIDE_BLOB_GC_WINDOW_MS } from './helpers/blob-gc-clock.js';
import { BLOB_GC_WINDOW, pushFreezeActiveAt } from '../src/services/blob-gc-window.js';

const at = (iso: string) => Date.parse(iso);
const TTL = 300;

describe('pushFreezeActiveAt', () => {
  it('matches the window the deploy trees schedule', () => {
    expect(BLOB_GC_WINDOW).toMatchObject({ dayOfWeekUtc: 0, startHourUtc: 3, startMinuteUtc: 10, maxRunMinutes: 25 });
  });

  it.each([
    // Sunday 2026-11-15
    ['2026-11-15T03:03:59Z', false], // before GC start − TTL − 60s (03:04:00)
    ['2026-11-15T03:04:00Z', true],
    ['2026-11-15T03:10:00Z', true], // GC starts
    ['2026-11-15T03:34:59Z', true], // job deadline 03:35
    ['2026-11-15T03:39:59Z', true], // tail
    ['2026-11-15T03:40:00Z', false],
    ['2026-11-14T03:10:00Z', false], // Saturday
    ['2026-11-16T03:10:00Z', false], // Monday
    ['2026-11-18T12:00:00Z', false],
  ])('%s → frozen=%s (300s tokens)', (iso, frozen) => {
    expect(pushFreezeActiveAt(at(iso), TTL)).toBe(frozen);
  });

  it('starts earlier when tokens live longer, so none is alive at GC start', () => {
    expect(pushFreezeActiveAt(at('2026-11-15T03:03:00Z'), TTL)).toBe(false);
    expect(pushFreezeActiveAt(at('2026-11-15T03:03:00Z'), 3600)).toBe(true);
  });

  it('reaches back across midnight into Saturday for a very long token TTL', () => {
    expect(pushFreezeActiveAt(at('2026-11-14T23:30:00Z'), 4 * 3600)).toBe(true);
    expect(pushFreezeActiveAt(at('2026-11-14T23:30:00Z'), TTL)).toBe(false);
  });
});

// The suites that issue REAL registry tokens must not read the wall clock: run
// inside the Sunday freeze, every push they expect would be withheld.
describe('token suites pin the freeze clock', () => {
  it('the pinned instant is outside the freeze for any plausible token TTL', () => {
    for (const ttl of [60, TTL, 3600, 6 * 3600]) {
      expect({ ttl, frozen: pushFreezeActiveAt(OUTSIDE_BLOB_GC_WINDOW_MS, ttl) }).toEqual({ ttl, frozen: false });
    }
  });

  it('every suite calling the real authorizeAndIssue pins setBlobGcClockForTests', () => {
    const dir = join(process.cwd(), 'test');
    const issuers = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts') && f !== 'blob-gc-window.test.ts')
      .map((f) => ({ f, src: readFileSync(join(dir, f), 'utf8') }))
      .filter(({ src }) => /authorizeAndIssue/.test(src)
        && !/unstable_mockModule\('\.\.\/src\/services\/token-service\.js'/.test(src));
    // Pull-only suites (signing-key rotation) never meet the freeze; every other
    // issuer asks for push somewhere and must pin.
    const unpinned = issuers
      .filter(({ src }) => /'push'/.test(src) && !/setBlobGcClockForTests\(\(\) => OUTSIDE_BLOB_GC_WINDOW_MS\)/.test(src))
      .map(({ f }) => f);
    expect(issuers.length).toBeGreaterThanOrEqual(4);
    expect(unpinned).toEqual([]);
  });
});
