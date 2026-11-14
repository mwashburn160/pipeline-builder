// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the REAL checkEntitlementOvercap (docs/billing-bundles.md):
 * whether an add-on change would drop a COUNT quota's cap below current pooled
 * usage. Guards seats (platform) + plugins/pipelines/listings (quota); fails OPEN
 * when a usage read errors. Base tier limits come from the api-core mock
 * (seats 10 / plugins 50 / pipelines 5 / listings 3); with no add-ons the effective caps ARE
 * those base limits, so we drive overages purely via the mocked usage reads.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Per-test usage knobs, read by the routed HTTP-client mock below.
let seatUsed: number | null = 0;
let pluginsUsed: number | null = 0;
let pipelinesUsed: number | null = 0;
let listingsUsed: number | null = 0;
/** Pooled support designations platform reports; `null` = incomplete payload. */
let supportUsed: { contacts: number; premium: number } | null = { contacts: 0, premium: 0 };
let transportFailure = false;

const mockGet = jest.fn<AnyFn>(async (path: string) => {
  if (transportFailure) return null; // the real safe client resolves null on a transport failure
  if (path.includes('/seat-usage')) {
    // REAL shape: platform's `sendSuccess(res, 200, { limit, used })` → the
    // payload is under `body.data`, NOT at the envelope root. (The old fixture
    // fabricated `{ used }` at the root, which masked readSeatUsage reading the
    // wrong path and silently disabling the seat over-cap guard.)
    return { statusCode: 200, body: { success: true, data: seatUsed === null ? {} : { limit: 10, used: seatUsed } } };
  }
  if (path.includes('/support-usage')) {
    return {
      statusCode: 200,
      body: {
        success: true,
        data: supportUsed === null ? {} : {
          supportContacts: { limit: 2, used: supportUsed.contacts },
          supportPremiumContacts: { limit: 1, used: supportUsed.premium },
        },
      },
    };
  }
  // /quotas/:orgId/:type → the pooled used count for that type
  const type = path.split('/').pop();
  const used = type === 'plugins' ? pluginsUsed : type === 'listings' ? listingsUsed : pipelinesUsed;
  return { statusCode: 200, body: { data: { status: used === null ? {} : { used } } } };
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // The shared billing tier mock plus the two support-contact caps (2 / 1).
  getTierLimits: () => ({
    seats: 10,
    plugins: 50,
    pipelines: 5,
    apiCalls: 25000,
    aiCalls: 50,
    storageBytes: 2147483648,
    dashboards: 20,
    alertRules: 50,
    alertDestinations: 10,
    idpConfigs: 1,
    listings: 3,
    eventRetentionDays: 30,
    doraRetentionDays: 180,
    supportContacts: 2,
    supportPremiumContacts: 1,
  }),
  createSafeClient: () => ({ get: mockGet, put: jest.fn<AnyFn>() }),
  getServiceAuthHeader: jest.fn(() => 'Bearer svc'),
  setCounterEmitter: jest.fn<AnyFn>(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: jest.fn<AnyFn>() }));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', async () => {
  const get = (section: string) => {
    if (section === 'server') return { services: { billingTimeout: 5000 } };
    return {};
  };
  return stubModule('@pipeline-builder/pipeline-core', {
    Config: { get, getAny: get },
    CoreConstants: { IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000, IDEMPOTENCY_TTL_MS: 300_000, IDEMPOTENCY_MAX_STORE_SIZE: 10_000 },
  });
});

// No bundles ⇒ empty catalog ⇒ effective = base tier limits (the real
// effectiveEntitlements runs against the mocked api-core getTierLimits).
jest.unstable_mockModule('../src/config/billing-config.js', () => ({
  getBillingConfig: () => ({ plans: [], bundles: [], comboDiscounts: [] }),
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3001 },
  },
}));

jest.unstable_mockModule('../src/models/billing-event.js', () => ({ BillingEvent: { create: jest.fn<AnyFn>() } }));

// Stub the provider factory so no real Stripe/AWS SDK is
// loaded for this over-cap unit suite.
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ syncAddons: jest.fn<AnyFn>() }),
}));

const { checkEntitlementOvercap } = await import('../src/helpers/entitlement-sync.js');

beforeEach(() => {
  jest.clearAllMocks();
  seatUsed = 0; pluginsUsed = 0; pipelinesUsed = 0; listingsUsed = 0; transportFailure = false;
  supportUsed = { contacts: 0, premium: 0 };
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

  it('flags a listings overage (removing a listing_pack below active listings)', async () => {
    listingsUsed = 7; // base cap 3
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toContainEqual({ quotaType: 'listings', currentUsage: 7, targetCap: 3, overage: 4 });
  });

  it('flags support contacts and premium upgrades over a reduced cap (a STOCK, like seats)', async () => {
    supportUsed = { contacts: 5, premium: 3 }; // caps 2 / 1
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual(expect.arrayContaining([
      { quotaType: 'supportContacts', currentUsage: 5, targetCap: 2, overage: 3 },
      { quotaType: 'supportPremiumContacts', currentUsage: 3, targetCap: 1, overage: 2 },
    ]));
    expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('/organization/org-1/support-usage'), expect.anything());
  });

  it('does not flag support contacts at the cap, and fails OPEN on an incomplete support read', async () => {
    supportUsed = { contacts: 2, premium: 1 };
    expect(await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x')).toEqual([]);
    supportUsed = null;
    expect(await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x')).toEqual([]);
  });

  it('does not flag usage exactly at the cap (boundary)', async () => {
    seatUsed = 10; pluginsUsed = 50; pipelinesUsed = 5; listingsUsed = 3;
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });

  it('fails OPEN (no overages) when a usage read returns no value', async () => {
    seatUsed = null; pluginsUsed = null; pipelinesUsed = null; listingsUsed = null;
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });

  it('fails OPEN when the usage read fails in transport (transient outage must not block removal)', async () => {
    transportFailure = true;
    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toEqual([]);
  });

  // Contract/regression for the root-cause bug: readSeatUsage must read the seat
  // count from `body.data.used` (platform's real sendSuccess envelope), NOT from a
  // root-level `body.used`. A root-only payload must read as "no value" → the
  // seats branch stays silent, proving the reader is bound to the real shape.
  it('does NOT read seat usage from a root-level `used` (real shape is body.data.used)', async () => {
    mockGet.mockImplementation(async (path: string) => {
      if (path.includes('/seat-usage')) {
        // WRONG (old fixture) shape: `used` at the envelope root, nothing under data.
        return { statusCode: 200, body: { success: true, used: 999 } };
      }
      const type = path.split('/').pop();
      const used = type === 'plugins' ? pluginsUsed : pipelinesUsed;
      return { statusCode: 200, body: { data: { status: { used } } } };
    });

    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    // 999 >> cap 10, but it lives at the wrong path, so the guard must see null
    // and NOT flag a seat overage.
    expect(overages.find((o) => o.quotaType === 'seats')).toBeUndefined();
  });

  it('DOES flag a seat overage from the real body.data.used envelope', async () => {
    mockGet.mockImplementation(async (path: string) => {
      if (path.includes('/seat-usage')) {
        return { statusCode: 200, body: { success: true, data: { limit: 10, used: 14 } } };
      }
      const type = path.split('/').pop();
      const used = type === 'plugins' ? pluginsUsed : pipelinesUsed;
      return { statusCode: 200, body: { data: { status: { used } } } };
    });

    const overages = await checkEntitlementOvercap('org-1', 'pro', [], 'Bearer x');
    expect(overages).toContainEqual({ quotaType: 'seats', currentUsage: 14, targetCap: 10, overage: 4 });
  });
});
