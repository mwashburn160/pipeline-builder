// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the REAL checkEntitlementOvercap (docs/billing-bundles.md §8):
 * whether an add-on change would drop a COUNT quota's cap below current pooled
 * usage. Guards seats (platform) + plugins/pipelines (quota); fails OPEN when a
 * usage read errors. Base tier limits come from the api-core mock
 * (seats 10 / plugins 50 / pipelines 5); with no add-ons the effective caps ARE
 * those base limits, so we drive overages purely via the mocked usage reads.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Per-test usage knobs, read by the routed HTTP-client mock below.
let seatUsed: number | null = 0;
let pluginsUsed: number | null = 0;
let pipelinesUsed: number | null = 0;
let throwOnGet = false;

const mockGet = jest.fn(async (path: string) => {
  if (throwOnGet) throw new Error('network');
  if (path.includes('/seat-usage')) {
    return { statusCode: 200, body: seatUsed === null ? {} : { used: seatUsed } };
  }
  // /quotas/:orgId/:type → the pooled used count for that type
  const type = path.split('/').pop();
  const used = type === 'plugins' ? pluginsUsed : pipelinesUsed;
  return { statusCode: 200, body: { data: { status: used === null ? {} : { used } } } };
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ get: mockGet, put: jest.fn() }),
  getServiceAuthHeader: jest.fn(() => 'Bearer svc'),
  setCounterEmitter: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: jest.fn() }));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => {
  const get = (section: string) => {
    if (section === 'server') return { services: { billingTimeout: 5000 } };
    return {}; // 'billing' → no bundles ⇒ empty catalog ⇒ effective = base tier limits
  };
  return {
    Config: { get, getAny: get },
    CoreConstants: { IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000, IDEMPOTENCY_TTL_MS: 300_000, IDEMPOTENCY_MAX_STORE_SIZE: 10_000 },
  };
});

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3001 },
  },
}));

jest.unstable_mockModule('../src/models/billing-event.js', () => ({ BillingEvent: { create: jest.fn() } }));

const { checkEntitlementOvercap } = await import('../src/helpers/billing-helpers.js');

beforeEach(() => {
  jest.clearAllMocks();
  seatUsed = 0; pluginsUsed = 0; pipelinesUsed = 0; throwOnGet = false;
});

describe('checkEntitlementOvercap', () => {
  it('returns no overages when all usage is within the effective caps', async () => {
    seatUsed = 8; pluginsUsed = 40; pipelinesUsed = 4; // all under 10/50/5
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });

  it('flags a seat overage with structured details', async () => {
    seatUsed = 13; // base cap 10
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toContainEqual({ quotaType: 'seats', currentUsage: 13, targetCap: 10, overage: 3 });
  });

  it('flags plugins and pipelines overages together', async () => {
    pluginsUsed = 55; pipelinesUsed = 9; // caps 50 / 5
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual(expect.arrayContaining([
      { quotaType: 'plugins', currentUsage: 55, targetCap: 50, overage: 5 },
      { quotaType: 'pipelines', currentUsage: 9, targetCap: 5, overage: 4 },
    ]));
  });

  it('does not flag usage exactly at the cap (boundary)', async () => {
    seatUsed = 10; pluginsUsed = 50; pipelinesUsed = 5;
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });

  it('fails OPEN (no overages) when a usage read returns no value', async () => {
    seatUsed = null; pluginsUsed = null; pipelinesUsed = null;
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });

  it('fails OPEN when the usage read throws (transient outage must not block removal)', async () => {
    throwOnGet = true;
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });
});
