// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The REAL config module (real api-core `envInt` / tier presets) must never
 * yield NaN from a malformed env var. A raw `parseInt` turned e.g.
 * `QUOTA_RESET_DAYS=three` into NaN, so every `getNextResetDate(NaN)` became an
 * Invalid Date and the `$dateAdd` reset pipeline got a NaN amount.
 */

import { describe, it, expect } from '@jest/globals';

process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.QUOTA_RESET_DAYS = 'three';
process.env.QUOTA_AT_RISK_CACHE_TTL_MS = 'soon';
process.env.QUOTA_DEFAULT_PLUGINS = 'lots';
process.env.QUOTA_DEFAULT_API_CALLS = '-1';
process.env.PORT = '';

const { getTierLimits } = await import('@pipeline-builder/api-core');
const { config } = await import('../src/config.js');

describe('config env parsing', () => {
  it('falls back to the default reset period instead of NaN', () => {
    expect(config.quota.resetDays).toBe(3);
  });

  it('falls back for other malformed numeric env vars', () => {
    expect(config.quota.atRiskCacheTtlMs).toBe(60000);
    expect(config.quota.defaults.plugins).toBe(getTierLimits('developer').plugins);
    expect(config.port).toBe(3000);
  });

  it('still honors a valid override, including -1 (unlimited)', () => {
    expect(config.quota.defaults.apiCalls).toBe(-1);
  });

  it('produces no NaN anywhere in the quota config', () => {
    const numbers = [config.port, config.quota.resetDays, config.quota.atRiskCacheTtlMs, ...Object.values(config.quota.defaults)];
    expect(numbers.every(Number.isFinite)).toBe(true);
  });
});
