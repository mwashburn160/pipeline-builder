// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cycle's impure seam (docs/plans/sales-agent.md Phases 2–3 joined up).
 *
 * Three properties, each of which is a money or privacy question rather than a
 * formatting one:
 *
 *  - **RECORD before DELIVER.** The row is the idempotency key; delivering first
 *    and then failing to write would offer the same account again next cycle,
 *    and two grants for one slot is money.
 *  - **consent is read LIVE.** A profile is a closed window, so an account that
 *    switched offers off yesterday must not be mailed from it — and an
 *    unreachable read must fail CLOSED.
 *  - **the slot is keyed on the profile PERIOD**, so a later period is a later
 *    offer while the same period twice is refused.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-run-cycle';

const mockCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  emitCounter: mockCounter,
  getServiceAuthHeader: () => 'Bearer svc',
  isValidTier: (t: string) => ['developer', 'pro', 'team', 'business', 'enterprise'].includes(t),
}));

// `stubModule`, never a bare factory: a factory replaces the whole namespace,
// so any export it omits links as `undefined` and breaks the moment production
// code reaches for it.
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// The order of effects is what this suite is for, so every effect is recorded
// on ONE list rather than on separate spies.
const effects: string[] = [];

const mockCreate = jest.fn<AnyFn>(async () => {
  effects.push('record');
  return {};
});
const mockOfferFindOne = jest.fn<AnyFn>();
const mockUpdateMany = jest.fn<AnyFn>(async () => ({ modifiedCount: 0 }));
jest.unstable_mockModule('../src/models/offer.js', () => ({
  Offer: {
    create: mockCreate,
    findOne: mockOfferFindOne,
    updateMany: mockUpdateMany,
    aggregate: jest.fn<AnyFn>(async () => []),
    find: jest.fn<AnyFn>(() => ({ select: () => ({ lean: async () => [] }) })),
  },
}));

const mockExists = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/models/offer-exclusion.js', () => ({
  OfferExclusion: { exists: mockExists },
}));

let profileRows: unknown[] = [];
jest.unstable_mockModule('../src/models/usage-profile.js', () => ({
  UsageProfile: {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => profileRows }) }) }),
  },
}));

let subscriptions: unknown[] = [];
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    find: () => ({
      cursor: () => ({
        async *[Symbol.asyncIterator]() { for (const s of subscriptions) yield s; },
      }),
    }),
  },
}));

const mockFetchProfile = jest.fn<AnyFn>();
const mockFetchFrustration = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/helpers/downstream-client.js', () => ({
  fetchUsageProfile: mockFetchProfile,
  fetchFrustrationSignal: mockFetchFrustration,
}));

const mockDeliver = jest.fn<AnyFn>(async () => {
  effects.push('deliver');
  return { inApp: true, email: 'sent' };
});
jest.unstable_mockModule('../src/helpers/offers-notify.js', () => ({
  deliverOffer: mockDeliver,
  offerEmailText: (f: { pack?: { priceCents: number } | null }) =>
    (f.pack && f.pack.priceCents > 0 ? { subject: 's', text: 'b' } : null),
}));

// EVERY export of each stubbed local module, not only the ones this suite uses:
// a factory replaces the whole namespace, so an omitted export links as
// `undefined` and the import graph fails to LOAD naming an unrelated symbol.
jest.unstable_mockModule('../src/config/billing-config.js', () => ({
  getBillingConfig: () => ({ plans: [{ id: 'pro', tier: 'pro', prices: { monthly: 4900, annual: 49_000 } }] }),
  loadBillingConfig: () => ({ plans: [] }),
  DEFAULT_BUNDLE_DIMENSION_MAP: {},
  assertCombosValid: () => undefined,
  assertBundleRequiresValid: () => undefined,
}));

jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  getBundleCatalog: () => ([{
    id: 'pipeline_pack',
    name: 'Pipeline pack',
    grants: { pipelines: 10 },
    stackable: true,
    prices: { monthly: 1199, annual: 11_990 },
    availableForTiers: ['pro'],
  }]),
  getBillingTimeout: () => 5_000,
  billingServiceAuth: () => 'Bearer svc',
  calculatePeriodEnd: (d: Date) => d,
  createBillingEvent: async () => undefined,
  recordReactivatePlanMissing: () => undefined,
  bundlesEnabled: () => true,
  bundleSelfServiceAllowed: () => true,
}));

jest.unstable_mockModule('../src/helpers/crossover.js', () => ({
  evaluateCrossover: () => ({ crossover: false, candidateTier: null, savingCents: 0, savingRequiresDrops: false }),
}));

const { runForAccount, runOfferCycle, loadProfiles } = await import('../src/helpers/offers-run.js');

const SUB = { orgId: 'acct-1', planId: 'pro', interval: 'monthly' as const, addons: [] };

/** A profile row with one dimension under sustained pressure. */
function row(over: Record<string, unknown> = {}) {
  return {
    period: '2026-11-01',
    dimensions: { pipelines: { ratio: 0.95, crossed: 90, used: 19, limit: 20 } },
    addonsHeld: [],
    subscriptionAgeDays: 400,
    complete: true,
    ...over,
  };
}

/** Three consecutive periods, which the sustained-pressure rule asks for. */
function history() {
  return [row(), row({ period: '2026-10-29' }), row({ period: '2026-10-26' })];
}

beforeEach(() => {
  jest.clearAllMocks();
  effects.length = 0;
  profileRows = history();
  subscriptions = [SUB];
  mockOfferFindOne.mockReturnValue({ sort: () => ({ lean: async () => null }) });
  mockExists.mockResolvedValue(null);
  mockFetchProfile.mockResolvedValue({
    orgId: 'acct-1',
    tier: 'pro',
    rootOrgId: 'acct-1',
    noticesEnabled: true,
    offersEnabled: true,
    dimensions: {},
  });
  mockFetchFrustration.mockResolvedValue(null);
  mockCreate.mockImplementation(async () => { effects.push('record'); return {}; });
  mockDeliver.mockImplementation(async () => { effects.push('deliver'); return { inApp: true, email: 'sent' }; });
});

describe('record before deliver', () => {
  it('writes the decision row BEFORE sending anything', async () => {
    const out = await runForAccount(SUB);
    expect(out?.decision.status).toBe('sent');
    expect(effects).toEqual(['record', 'deliver']);
  });

  it('does not deliver at all when the row loses on the unique index', async () => {
    // A duplicate is a NO-OP, not an error: the first writer's decision stands,
    // and re-delivering would be a second offer for one slot.
    mockCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const out = await runForAccount(SUB);
    expect(out).toMatchObject({ recorded: false });
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('stores the copy AS SENT on the row', async () => {
    await runForAccount(SUB);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ subject: 's', body: 'b', status: 'sent' });
  });

  it('keys the slot on the profile PERIOD, not on the clock', async () => {
    await runForAccount(SUB);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ cycleKey: 'period:2026-11-01' });
  });

  it('records the operator trigger as MANUAL', async () => {
    await runForAccount(SUB, new Date(), 'manual');
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ source: 'manual' });
  });
});

describe('consent is live, and fails closed', () => {
  it('does not deliver when the live read says offers are off', async () => {
    mockFetchProfile.mockResolvedValue({
      orgId: 'acct-1',
      tier: 'pro',
      rootOrgId: 'acct-1',
      noticesEnabled: true,
      offersEnabled: false,
      dimensions: {},
    });
    const out = await runForAccount(SUB);
    expect(out?.decision.reason).toBe('offers_disabled_account');
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the consent read is unreachable', async () => {
    // The opposite of the customer-facing quota path, deliberately: a profile
    // assembled from a failed read must not be believed.
    mockFetchProfile.mockResolvedValue(null);
    const out = await runForAccount(SUB);
    expect(out?.decision.reason).toBe('offers_disabled_account');
  });

  it('passes BOTH switches to the delivery leg, which re-checks them', async () => {
    await runForAccount(SUB);
    expect(mockDeliver.mock.calls[0]![0]).toMatchObject({
      rootOrgId: 'acct-1',
      consent: { accountOptIn: true, noticesEnabled: true },
    });
  });

  it('decides and records against the ACCOUNT ROOT, not the team', async () => {
    mockFetchProfile.mockResolvedValue({
      orgId: 'team-7',
      tier: 'pro',
      rootOrgId: 'acct-1',
      noticesEnabled: true,
      offersEnabled: true,
      dimensions: {},
    });
    await runForAccount({ ...SUB, orgId: 'team-7' });
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ orgId: 'acct-1' });
  });
});

describe('the operator veto and the model signal', () => {
  it('refuses an excluded account', async () => {
    mockExists.mockResolvedValue({ _id: 'x' });
    const out = await runForAccount(SUB);
    expect(out?.decision.reason).toBe('offers_disabled_account');
  });

  it('refuses a frustrated one, on its own named reason', async () => {
    mockFetchFrustration.mockResolvedValue({ frustrated: true, confidence: 0.9, degraded: false });
    const out = await runForAccount(SUB);
    expect(out?.decision.reason).toBe('account_frustrated');
  });

  it('is unaffected when the signal is unreachable', async () => {
    mockFetchFrustration.mockRejectedValue(new Error('down'));
    const out = await runForAccount(SUB);
    expect(out?.decision.status).toBe('sent');
  });
});

describe('nothing to decide is not a suppression', () => {
  it('returns null for an account with no profile history', async () => {
    profileRows = [];
    await expect(runForAccount(SUB)).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns null for a plan that is not in the catalogue', async () => {
    await expect(runForAccount({ ...SUB, planId: 'gone' })).resolves.toBeNull();
  });
});

describe('loadProfiles', () => {
  it('normalises a Map-typed dimensions path, which would otherwise read as empty', async () => {
    profileRows = [{
      period: '2026-11-01',
      dimensions: new Map([['pipelines', { ratio: 0.9, crossed: 90, used: 9, limit: 10 }]]),
      addonsHeld: ['seat_pack'],
      subscriptionAgeDays: 100,
      complete: true,
    }];
    const [loaded] = await loadProfiles('acct-1');
    expect(loaded!.dimensions.pipelines).toEqual({ ratio: 0.9, crossed: 90, used: 9, limit: 10 });
  });

  it('defaults a partial dimension rather than letting undefined reach a rule', async () => {
    profileRows = [{ period: '2026-11-01', dimensions: { plugins: {} }, complete: false }];
    const [loaded] = await loadProfiles('acct-1');
    expect(loaded!.dimensions.plugins).toEqual({ ratio: null, crossed: null, used: 0, limit: 0 });
    expect(loaded!.addonsHeld).toEqual([]);
    expect(loaded!.complete).toBe(false);
  });
});

describe('the whole cycle', () => {
  it('sweeps expired offers BEFORE deciding, so a lapsed one cannot hold a slot', async () => {
    await runOfferCycle(new Date('2026-11-20T00:00:00Z'));
    expect(mockUpdateMany).toHaveBeenCalled();
  });

  it('counts a send per type and a suppression per reason', async () => {
    await runOfferCycle();
    expect(mockCounter).toHaveBeenCalledWith('billing_offers_total', { outcome: 'sent', type: 'pack' });
  });

  it('counts a suppression under its own reason', async () => {
    mockExists.mockResolvedValue({ _id: 'x' });
    const result = await runOfferCycle();
    expect(result.suppressed).toEqual({ offers_disabled_account: 1 });
    expect(mockCounter).toHaveBeenCalledWith('billing_offers_total', {
      outcome: 'suppressed', reason: 'offers_disabled_account',
    });
  });

  it('skips one account’s failure without ending the cycle', async () => {
    subscriptions = [{ ...SUB, orgId: 'bad' }, SUB];
    mockFetchProfile.mockImplementation(async (orgId: string) => {
      if (orgId === 'bad') throw new Error('boom');
      return { orgId, tier: 'pro', rootOrgId: orgId, noticesEnabled: true, offersEnabled: true, dimensions: {} };
    });
    const result = await runOfferCycle();
    // The failing account is skipped (its throw escapes `runForAccount`), and
    // the next one still gets its turn.
    expect(result.sent).toBe(1);
  });

  it('does not count an unevaluable account as considered', async () => {
    profileRows = [];
    const result = await runOfferCycle();
    expect(result).toMatchObject({ considered: 0, sent: 0 });
  });
});
