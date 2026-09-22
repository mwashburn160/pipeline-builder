// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { clampRetentionDays, normalizeRetentionDays, RETENTION_MAX_DAYS } from '../src/utils/retention.js';

describe('retention bounds', () => {
  it('clamps to the ceiling and passes the unlimited sentinel', () => {
    expect(clampRetentionDays(30)).toBe(30);
    expect(clampRetentionDays(10_000)).toBe(RETENTION_MAX_DAYS);
    expect(clampRetentionDays(-1)).toBe(-1);
  });
  it('normalizes untrusted input', () => {
    expect(normalizeRetentionDays(-1)).toBe(-1);
    expect(normalizeRetentionDays(1)).toBe(1);
    expect(normalizeRetentionDays(731)).toBe(730);
    for (const bad of [0, -2, 1.5, '30', null, undefined]) expect(normalizeRetentionDays(bad)).toBeNull();
  });
});
