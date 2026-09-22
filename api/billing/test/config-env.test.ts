// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The REAL billing config must never yield NaN from a malformed env var — a NaN
 * lifecycle / metering interval makes `setInterval` fire continuously, a NaN
 * grace period never downgrades — and a typo'd provider must not silently run
 * billing on the stub provider without saying so.
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';

const TOUCHED = [
  'MONGODB_URI', 'PORT', 'BILLING_PROVIDER', 'BILLING_LIFECYCLE_CHECK_INTERVAL_MS', 'PAYMENT_GRACE_PERIOD_DAYS',
  'BILLING_METERING_INTERVAL_MS', 'BILLING_DISCOUNT_MAX_PERCENT', 'BILLING_DISCOUNT_MAX_CENTS', 'QUOTA_SERVICE_PORT',
  'BILLING_METERING_ENABLED', 'BILLING_DISCOUNTS_ENABLED', 'BILLING_PROMOTIONS_ENABLED', 'BILLING_ENTITLEMENT_DRIFT_MAX_PER_TICK',
] as const;
const original = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

async function loadConfig(env: Record<string, string>) {
  for (const k of TOUCHED) delete process.env[k];
  process.env.MONGODB_URI = 'mongodb://test:27017/billing';
  Object.assign(process.env, env);
  const mod = await import(`../src/config.js?env=${Math.random()}`);
  return mod.config as typeof import('../src/config.js').config;
}

describe('billing config env parsing', () => {
  afterEach(() => {
    for (const k of TOUCHED) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    jest.restoreAllMocks();
  });

  it('falls back to the default (with a warning) instead of NaN for malformed integers', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = await loadConfig({
      PORT: 'eighty',
      BILLING_LIFECYCLE_CHECK_INTERVAL_MS: '1h',
      PAYMENT_GRACE_PERIOD_DAYS: 'seven',
      BILLING_METERING_INTERVAL_MS: '12abc',
      QUOTA_SERVICE_PORT: '30.5',
    });
    expect(config.port).toBe(3000);
    expect(config.lifecycleCheckIntervalMs).toBe(3_600_000);
    expect(config.paymentGracePeriodDays).toBe(7);
    expect(config.meteringIntervalMs).toBe(3_600_000);
    expect(config.quotaService.port).toBe(3000);
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('BILLING_LIFECYCLE_CHECK_INTERVAL_MS'))).toBe(true);
    expect(warned.some((m) => m.includes('PAYMENT_GRACE_PERIOD_DAYS'))).toBe(true);
  });

  it('produces no NaN anywhere in the numeric config', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = await loadConfig({ BILLING_DISCOUNT_MAX_CENTS: 'lots', BILLING_ENTITLEMENT_DRIFT_MAX_PER_TICK: 'x' });
    const numbers = [
      config.port, config.paymentGracePeriodDays, config.renewalReminderDays, config.lifecycleCheckIntervalMs,
      config.entitlementDriftMaxPerTick, config.entitlementDriftIntervalMs, config.meteringIntervalMs,
      config.discounts.maxPercent, config.discounts.maxCents, config.promotions.backfillIntervalMs,
      config.promotions.clawbackWindowMs, config.quotaService.port, config.platformService.port,
    ];
    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(config.discounts.maxCents).toBe(10_000_000);
  });

  it('honors valid overrides and clamps the percent ceiling to 100', async () => {
    const config = await loadConfig({ BILLING_DISCOUNT_MAX_PERCENT: '250', PAYMENT_GRACE_PERIOD_DAYS: '3' });
    expect(config.discounts.maxPercent).toBe(100);
    expect(config.paymentGracePeriodDays).toBe(3);
  });

  it('warns and reports the stub provider for an unknown BILLING_PROVIDER', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = await loadConfig({ BILLING_PROVIDER: 'strpe' });
    expect(config.billingProvider).toBe('stub');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('BILLING_PROVIDER'))).toBe(true);
  });

  it('keeps a valid provider', async () => {
    expect((await loadConfig({ BILLING_PROVIDER: 'stripe' })).billingProvider).toBe('stripe');
  });

  it('parses the boolean switches with envBool semantics', async () => {
    let config = await loadConfig({});
    expect(config.meteringEnabled).toBe(false);
    expect(config.discounts.enabled).toBe(true);
    expect(config.promotions.enabled).toBe(true);

    config = await loadConfig({ BILLING_METERING_ENABLED: 'TRUE', BILLING_DISCOUNTS_ENABLED: 'false' });
    expect(config.meteringEnabled).toBe(true);
    expect(config.marketplace.meteringEnabled).toBe(true);
    expect(config.discounts.enabled).toBe(false);
    // Promotions ride the discount machinery — discounts off ⇒ promotions off.
    expect(config.promotions.enabled).toBe(false);
  });
});
