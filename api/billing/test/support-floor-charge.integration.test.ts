// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The support size floor is BILLED — once per billing period — against a REAL
 * MongoDB (mongodb-memory-server).
 *
 * The floor's top-up used to be computed and shown (`GET /charges`, the add-on
 * preview) but charged nowhere: no provider call, no invoice line. What is under
 * test is the period claim, which only a real `$ne`-guarded `$push` can vouch
 * for: a redelivered webhook, a second invoice in the same period and two
 * replicas racing all charge the floor exactly once, and a provider failure
 * gives the period back so the redelivery can charge it.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { loadBillingConfig } from '../src/config/billing-config.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
}));
const createBillingEvent = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({
  createBillingEvent: (...a: unknown[]) => createBillingEvent(...a),
  getBundleCatalog: () => loadBillingConfig().bundles,
}));
const addInvoiceCharge = jest.fn<(...a: unknown[]) => Promise<{ ref: string }>>();
let provider: Record<string, unknown> = {};
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => provider }));

const suite = integrationSuite();

suite('Support size floor charge (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, Subscription: any, Plan: any, charge: any, supportFloorLine: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    await mongoose.connect(mongod.getUri());
    ({ Subscription } = await import('../src/models/subscription.js'));
    ({ Plan } = await import('../src/models/plan.js'));
    await Subscription.init();
    ({ chargeSupportFloorForPeriod: charge } = await import('../src/helpers/support-floor-charge.js'));
    ({ supportFloorLine } = await import('../src/helpers/support-floor.js'));
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  /** 3 standard contacts + 20 seat packs on enterprise: 35 seats, the ramp binds. */
  const ADDONS = [{ bundleId: 'support_standard', quantity: 3 }, { bundleId: 'seat', quantity: 20 }];

  beforeEach(async () => {
    await Subscription.deleteMany({});
    await Plan.deleteMany({});
    await Plan.create({ _id: 'enterprise', name: 'Enterprise', tier: 'enterprise', prices: { monthly: 49900, annual: 499000 } });
    jest.clearAllMocks();
    addInvoiceCharge.mockImplementation(async () => ({ ref: 'ii_1' }));
    provider = { addInvoiceCharge: (...a: unknown[]) => addInvoiceCharge(...a) };
  });

  const seed = (over: Record<string, unknown> = {}) => Subscription.create({
    orgId: 'org-1',
    planId: 'enterprise',
    status: 'active',
    interval: 'monthly',
    currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
    externalId: 'sub_ext',
    externalCustomerId: 'cus_1',
    addons: ADDONS,
    ...over,
  });
  const expectedLine = (interval: 'monthly' | 'annual', override?: { seats: number; floorCents: number }) =>
    supportFloorLine('enterprise', ADDONS, loadBillingConfig().bundles, interval, undefined, override);

  it('charges the top-up once, as a labelled line on the subscription\'s next invoice', async () => {
    const sub = await seed();
    const line = expectedLine('monthly');
    expect(line?.cents).toBeGreaterThan(0);

    expect(await charge(sub, '2026-11-01')).toEqual({ status: 'charged', cents: line.cents });
    expect(addInvoiceCharge).toHaveBeenCalledTimes(1);
    expect(addInvoiceCharge).toHaveBeenCalledWith('cus_1', 'sub_ext', line.cents, line.label, `support-floor-${sub._id}-2026-11-01`);
    const row = await Subscription.findById(sub._id).lean();
    expect(row.supportFloorCharges).toEqual([expect.objectContaining({ periodKey: '2026-11-01', cents: line.cents, providerRef: 'ii_1' })]);
  });

  it('a redelivered webhook (stale in-memory doc) or a second invoice in the period charges nothing', async () => {
    const sub = await seed();
    await charge(sub, '2026-11-01');
    // The same in-memory doc, which has NOT seen the claim — only the guarded write stops it.
    expect(await charge(sub, '2026-11-01')).toEqual({ status: 'already_charged' });
    expect(addInvoiceCharge).toHaveBeenCalledTimes(1);
    // The NEXT period is a new charge.
    expect((await charge(await Subscription.findById(sub._id), '2026-12-01')).status).toBe('charged');
    expect(addInvoiceCharge).toHaveBeenCalledTimes(2);
  });

  it('replicas racing the same period charge it exactly once', async () => {
    const sub = await seed();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => charge(sub, '2026-11-01')));
    expect(outcomes.filter((o: { status: string }) => o.status === 'charged')).toHaveLength(1);
    expect(addInvoiceCharge).toHaveBeenCalledTimes(1);
  });

  it('a provider failure gives the period back and throws, so the redelivery charges it once', async () => {
    const sub = await seed();
    addInvoiceCharge.mockRejectedValueOnce(new Error('stripe down'));
    await expect(charge(sub, '2026-11-01')).rejects.toThrow('stripe down');
    expect((await Subscription.findById(sub._id).lean()).supportFloorCharges).toEqual([]);
    expect((await charge(sub, '2026-11-01')).status).toBe('charged');
    expect(addInvoiceCharge).toHaveBeenCalledTimes(2);
  });

  it('bills an ANNUAL interval once, at the ten-month figure — never per month', async () => {
    const sub = await seed({ interval: 'annual' });
    const annual = expectedLine('annual');
    const monthly = expectedLine('monthly');
    expect(await charge(sub, '2026-11-01')).toEqual({ status: 'charged', cents: annual.cents });
    expect(annual.cents).toBeGreaterThan(monthly.cents);
  });

  it('bills a NEGOTIATED floor at the agreed figure', async () => {
    const override = { seats: 2500, floorCents: 800_000 };
    const sub = await seed({ supportFloorOverride: { ...override, agreedAt: new Date(), agreedBy: 'op-1' } });
    const line = expectedLine('monthly', override);
    expect(line.negotiated).toBe(true);
    expect(await charge(sub, '2026-11-01')).toEqual({ status: 'charged', cents: line.cents });
  });

  it.each([
    ['holds no support', { addons: [{ bundleId: 'seat', quantity: 20 }] }],
    ['is canceled', { status: 'canceled' }],
    ['lapsed into the grace downgrade', { metadata: { gracePeriodDowngradedAt: new Date() } }],
  ])('charges nothing to an account that %s', async (_label, over) => {
    const sub = await seed(over);
    expect((await charge(sub, '2026-11-01')).status).toBe('none');
    expect(addInvoiceCharge).not.toHaveBeenCalled();
  });

  it('reports the floor unrealizable (and claims nothing) when the provider cannot bill a line', async () => {
    provider = {};
    const sub = await seed();
    expect(await charge(sub, '2026-11-01')).toEqual({ status: 'unrealizable' });
    expect((await Subscription.findById(sub._id).lean()).supportFloorCharges).toEqual([]);
  });
});
