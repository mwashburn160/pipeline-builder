// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Subscription integrity against a REAL MongoDB (mongodb-memory-server).
 *
 * Two guarantees here are enforced by the DATABASE, not by code a mock can see:
 *
 *  1. At most one MANAGEABLE (active / trialing / past_due) subscription per org —
 *     the partial unique index on `subscriptions.orgId` is the atomic backstop
 *     behind the app-level duplicate pre-check, so two concurrent provisions can't
 *     both land and double-bill.
 *  2. A lapsed `past_due` subscription is downgraded EXACTLY ONCE — the lifecycle
 *     cron claims each lapse with a conditional `findOneAndUpdate` before any side
 *     effect, so two replicas (or two overlapping ticks) racing the same row
 *     produce one downgrade, one billing event and one notification.
 *
 * The mock-based subscription-lifecycle suite can only check the filter it BUILT;
 * this one runs the real model and the real cron leg against a real mongod.
 * Peripheral legs (provider calls, downstream syncs) are stubbed — they are not
 * what is under test.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSyncEntitlements = jest.fn<(...args: unknown[]) => Promise<boolean>>();
const mockNotify = jest.fn<(...args: unknown[]) => Promise<boolean>>();
let lifecycleRun: (() => Promise<void>) | undefined;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSystemNotification: (...a: unknown[]) => mockNotify(...a),
  createScheduler: (opts: { run: () => Promise<void> }) => {
    lifecycleRun = opts.run;
    return { start: () => undefined, stop: () => undefined };
  },
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));
jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    paymentGracePeriodDays: 7,
    renewalReminderDays: 7,
    lifecycleCheckIntervalMs: 3600000,
    entitlementDriftMaxPerTick: 100,
    entitlementDriftIntervalMs: 86400000,
    messageService: { host: 'message', port: 3000 },
    quotaService: { host: 'quota', port: 3000 },
    platformService: { host: 'platform', port: 3000 },
    complianceService: { host: 'compliance', port: 3000 },
    reportingService: { host: 'reporting', port: 3000 },
  },
}));
jest.unstable_mockModule('../src/helpers/entitlement-sync.js', () => ({
  syncEntitlements: (...a: unknown[]) => mockSyncEntitlements(...a),
  effectiveFeatureSet: () => [],
  pushComplianceSetsToCompliance: async () => true,
  currentSubscriptionEntitlement: async () => ({ tier: 'developer', addons: [] }),
}));
// The other lifecycle legs have their own suites; only the grace leg is under test.
jest.unstable_mockModule('../src/helpers/entitlement-drift.js', () => ({ reconcileEntitlementDrift: async () => undefined }));
jest.unstable_mockModule('../src/helpers/provider-reconcile.js', () => ({ reconcileUnknownProviderOutcomes: async () => undefined }));
jest.unstable_mockModule('../src/helpers/credit-debits.js', () => ({ retryPendingCreditDebits: async () => 0 }));
jest.unstable_mockModule('../src/helpers/addon-prune.js', () => ({ syncProviderAddons: async () => undefined }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ name: 'stripe', getSubscription: async () => ({ status: 'active' }) }),
}));

const suite = integrationSuite();

suite('Subscription integrity (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, Subscription: any, BillingEvent: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    await mongoose.connect(mongod.getUri());
    ({ Subscription } = await import('../src/models/subscription.js'));
    ({ BillingEvent } = await import('../src/models/billing-event.js'));
    // Build indexes the way the service does at boot (mongoose autoIndex → init).
    // It REJECTS today — see the KNOWN BUG note below — and boot swallows that
    // (autoIndex errors surface only as a model "error" event), so this does too.
    await Subscription.init().catch(() => undefined);
    await BillingEvent.init();
    await import('../src/helpers/subscription-lifecycle.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Subscription.deleteMany({});
    await BillingEvent.deleteMany({});
    mockSyncEntitlements.mockReset().mockResolvedValue(true);
    mockNotify.mockReset().mockResolvedValue(true);
  });

  const DAY = 24 * 3600_000;
  const sub = (over: Record<string, unknown> = {}) => ({
    orgId: 'org-1',
    planId: 'pro',
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 10 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    ...over,
  });

  // ── 1. one manageable subscription per org ────────────────────────────────
  //
  // KNOWN BUG (found by this suite): the partial unique index is NEVER BUILT.
  // Regression: a field-level `index: true` on orgId once claimed the name
  // `orgId_1`, so this partial unique index silently failed to build and
  // concurrent provisions could double-bill. It is now named explicitly.

  it('builds the partial unique index on orgId', async () => {
    const idx = (await Subscription.collection.indexes()).find((i: { key: Record<string, number> }) => JSON.stringify(i.key) === '{"orgId":1}');
    expect(idx).toMatchObject({ unique: true, partialFilterExpression: { status: { $in: ['active', 'trialing', 'past_due'] } } });
  });

  it.each([
    ['active', 'active'],
    ['active', 'trialing'],
    ['trialing', 'trialing'],
    ['past_due', 'active'],
  ])('rejects a second manageable subscription (%s then %s) with a duplicate-key error', async (first, second) => {
    await Subscription.create(sub({ status: first }));
    await expect(Subscription.create(sub({ status: second }))).rejects.toMatchObject({ code: 11000 });
  });

  it('lets two concurrent provisions race and keeps exactly one', async () => {
    const results = await Promise.allSettled([
      Subscription.create(sub({ status: 'trialing', externalId: 'sub_a' })),
      Subscription.create(sub({ status: 'trialing', externalId: 'sub_b' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Subscription.countDocuments({ orgId: 'org-1' })).toBe(1);
  });

  it('does not count terminal history: a canceled row and a new active one coexist', async () => {
    await Subscription.create(sub({ status: 'canceled' }));
    await Subscription.create(sub({ status: 'canceled' }));
    await expect(Subscription.create(sub({ status: 'active' }))).resolves.toBeDefined();
  });

  it('is per org', async () => {
    await Subscription.create(sub({ orgId: 'org-1' }));
    await expect(Subscription.create(sub({ orgId: 'org-2' }))).resolves.toBeDefined();
  });

  // ── 2. grace-period claim ─────────────────────────────────────────────────

  const lapsed = () => sub({ status: 'past_due', firstFailedAt: new Date(Date.now() - 8 * DAY), failedPaymentAttempts: 4 });

  it('downgrades a lapsed past_due subscription once, and stamps the marker', async () => {
    const s = await Subscription.create(lapsed());
    await lifecycleRun!();
    expect(mockSyncEntitlements).toHaveBeenCalledTimes(1);
    expect(mockSyncEntitlements.mock.calls[0]?.[1]).toBe('developer');
    const after = await Subscription.findById(s._id).lean();
    expect(after.status).toBe('past_due');
    expect(after.metadata.gracePeriodDowngradedAt).toEqual(expect.any(String));

    // The next tick must not re-downgrade (the marker excludes it).
    await lifecycleRun!();
    expect(mockSyncEntitlements).toHaveBeenCalledTimes(1);
  });

  it('two overlapping ticks racing the same lapse downgrade it EXACTLY once', async () => {
    await Subscription.create(lapsed());
    await Promise.all([lifecycleRun!(), lifecycleRun!(), lifecycleRun!()]);
    expect(mockSyncEntitlements).toHaveBeenCalledTimes(1);
    expect(await BillingEvent.countDocuments({ 'orgId': 'org-1', 'details.reason': 'grace_period_expired' })).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('leaves a past_due subscription still inside its grace window alone', async () => {
    await Subscription.create(sub({ status: 'past_due', firstFailedAt: new Date(Date.now() - 2 * DAY) }));
    await lifecycleRun!();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });

  it('a payment recovery that lands before the claim wins: no downgrade', async () => {
    const s = await Subscription.create(lapsed());
    // Recovery flips the row to active between the scan and the claim — modelled
    // by recovering first: the claim's predicate (status past_due) no longer matches.
    await Subscription.updateOne({ _id: s._id }, { $set: { status: 'active', firstFailedAt: null } });
    await lifecycleRun!();
    expect(mockSyncEntitlements).not.toHaveBeenCalled();
  });
});
