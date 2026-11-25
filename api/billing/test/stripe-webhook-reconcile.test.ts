// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/stripe-webhook-reconcile.ts — keeps the Stripe webhook endpoint's
 * `enabled_events` a superset of the events billing handles.
 *
 * The endpoint is configured by hand in the Stripe Dashboard. On "selected
 * events", an event billing handles but the endpoint does not subscribe to is
 * never delivered, and nothing anywhere says so. The reconcile closes that:
 * additive (other consumers' events stay), `['*']` left alone, and a failure
 * never blocks startup — it is logged by name and published as a gauge.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock, loggerMock } from './helpers/mock-api-core.js';

const logger = loggerMock();
const start = jest.fn<AnyFn>();
const stop = jest.fn<AnyFn>();
interface CapturedScheduler {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  onSkipped?: () => void;
  lock?: { key: string; ttlMs: number };
}
let schedulerOpts: CapturedScheduler | undefined;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => logger,
  createScheduler: (opts: typeof schedulerOpts) => { schedulerOpts = opts; return { start, stop }; },
}));

const gauges = new Map<string, number>();
const setGauge = jest.fn((name: string, _l: Record<string, string>, v: number) => { gauges.set(name, v); });
const resetGauge = jest.fn((name: string) => { gauges.delete(name); });
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge, resetGauge }));

const cfg = { billingProvider: 'stripe', stripe: { webhookEndpointId: '', webhookUrl: 'https://pb.example.com/billing/stripe/webhook' } };
jest.unstable_mockModule('../src/config.js', () => ({ config: cfg }));

interface Endpoint { id: string; url: string; enabledEvents: string[]; livemode: boolean; enabled?: boolean }
class FakeStripeProvider {
  keyMode: 'live' | 'test' | null = 'live';
  endpoints: Endpoint[] = [];
  list = jest.fn(async (): Promise<Endpoint[]> => this.endpoints.map((e) => ({ ...e })));
  retrieve = jest.fn(async (id: string): Promise<Endpoint> => {
    const e = this.endpoints.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error(`No such webhook endpoint: '${id}'`), { code: 'resource_missing' });
    return { ...e };
  });
  update = jest.fn(async (id: string, events: string[]): Promise<Endpoint> => {
    const e = this.endpoints.find((x) => x.id === id)!;
    e.enabledEvents = [...events];
    return { ...e };
  });
  getKeyMode() { return this.keyMode; }
  listWebhookEndpoints() { return this.list(); }
  retrieveWebhookEndpoint(id: string) { return this.retrieve(id); }
  updateWebhookEndpointEvents(id: string, events: string[]) { return this.update(id, events); }
}
let provider: unknown;
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => ({ StripeProvider: FakeStripeProvider }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => provider }));

const {
  reconcileStripeWebhookEvents, startStripeWebhookReconcile, stopStripeWebhookReconcile,
  WEBHOOK_EVENTS_MISSING_METRIC, RECONCILE_INTERVAL_MS,
} = await import('../src/helpers/stripe-webhook-reconcile.js');

const HANDLED = ['customer.subscription.created', 'invoice.payment_succeeded', 'charge.dispute.closed'] as const;
const URL = 'https://pb.example.com/billing/stripe/webhook';

let fake: FakeStripeProvider;
beforeEach(() => {
  jest.clearAllMocks();
  gauges.clear();
  cfg.billingProvider = 'stripe';
  cfg.stripe.webhookEndpointId = '';
  cfg.stripe.webhookUrl = URL;
  fake = new FakeStripeProvider();
  provider = fake;
});
afterEach(() => { stopStripeWebhookReconcile(); });

const missingGauge = () => gauges.get(WEBHOOK_EVENTS_MISSING_METRIC);

describe('reconcileStripeWebhookEvents', () => {
  it('ADDS the handled events the endpoint is missing, and keeps the events it already had', async () => {
    fake.endpoints = [
      { id: 'we_other', url: 'https://elsewhere.example.com/hook', enabledEvents: ['payout.paid'], livemode: true },
      { id: 'we_1', url: URL, enabledEvents: ['customer.subscription.created', 'payout.paid'], livemode: true },
    ];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out).toMatchObject({ status: 'updated', endpointId: 'we_1', added: ['invoice.payment_succeeded', 'charge.dispute.closed'], missing: [] });
    // Additive: `payout.paid` belongs to some other consumer of this endpoint.
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.update.mock.calls[0][0]).toBe('we_1');
    expect([...fake.update.mock.calls[0][1]].sort()).toEqual(
      ['charge.dispute.closed', 'customer.subscription.created', 'invoice.payment_succeeded', 'payout.paid'],
    );
    expect(missingGauge()).toBe(0);
  });

  it('leaves an endpoint subscribed to every event (`*`) untouched', async () => {
    fake.endpoints = [{ id: 'we_1', url: URL, enabledEvents: ['*'], livemode: true }];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('all_events');
    expect(fake.update).not.toHaveBeenCalled();
    expect(missingGauge()).toBe(0);
  });

  it('does not write when nothing is missing', async () => {
    fake.endpoints = [{ id: 'we_1', url: URL, enabledEvents: [...HANDLED, 'payout.paid'], livemode: true }];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('complete');
    expect(fake.update).not.toHaveBeenCalled();
    expect(missingGauge()).toBe(0);
  });

  it('finds the endpoint by STRIPE_WEBHOOK_ENDPOINT_ID before the URL', async () => {
    cfg.stripe.webhookEndpointId = 'we_pinned';
    fake.endpoints = [
      { id: 'we_url', url: URL, enabledEvents: [], livemode: true },
      { id: 'we_pinned', url: 'https://proxy.example.com/hook', enabledEvents: [], livemode: true },
    ];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out).toMatchObject({ status: 'updated', endpointId: 'we_pinned' });
    expect(fake.retrieve).toHaveBeenCalledWith('we_pinned');
    expect(fake.list).not.toHaveBeenCalled();
  });

  it('a DISABLED endpoint delivers nothing: every handled event is missing, whatever it lists', async () => {
    // Stripe disables an endpoint after days of failed deliveries; its event list
    // is intact, so reading only the list reported `complete` with nothing arriving.
    fake.endpoints = [{ id: 'we_1', url: URL, enabledEvents: ['*'], livemode: true, enabled: false }];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out).toMatchObject({ status: 'endpoint_disabled', endpointId: 'we_1', missing: [...HANDLED] });
    expect(missingGauge()).toBe(HANDLED.length);
    expect(fake.update).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('prefers the enabled endpoint when a disabled one shares the URL', async () => {
    fake.endpoints = [
      { id: 'we_old', url: URL, enabledEvents: [], livemode: true, enabled: false },
      { id: 'we_new', url: URL, enabledEvents: [...HANDLED], livemode: true },
    ];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out).toMatchObject({ status: 'complete', endpointId: 'we_new' });
  });

  it('matches the URL ignoring a trailing slash', async () => {
    fake.endpoints = [{ id: 'we_1', url: `${URL}/`, enabledEvents: [...HANDLED], livemode: true }];
    expect((await reconcileStripeWebhookEvents(fake as never, HANDLED)).status).toBe('complete');
  });

  it('ignores an endpoint from the other Stripe world (test vs live)', async () => {
    fake.keyMode = 'live';
    fake.endpoints = [{ id: 'we_test', url: URL, enabledEvents: [], livemode: false }];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('endpoint_not_found');
    expect(fake.update).not.toHaveBeenCalled();
  });

  it('an update failure (restricted key) publishes the missing count and logs the names — it never throws', async () => {
    fake.endpoints = [{ id: 'we_1', url: URL, enabledEvents: ['customer.subscription.created'], livemode: true }];
    fake.update.mockRejectedValueOnce(Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError' }));

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out).toMatchObject({ status: 'update_failed', missing: ['invoice.payment_succeeded', 'charge.dispute.closed'] });
    expect(missingGauge()).toBe(2);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('invoice.payment_succeeded');
    expect(logged).toContain('charge.dispute.closed');
  });

  it('a lookup failure (network) counts every handled event as unconfirmed', async () => {
    fake.list.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('lookup_failed');
    expect(missingGauge()).toBe(HANDLED.length);
    expect(logger.error).toHaveBeenCalled();
  });

  it('no endpoint at the URL (and no id) counts every handled event as missing and says how to fix it', async () => {
    fake.endpoints = [{ id: 'we_x', url: 'https://elsewhere.example.com/hook', enabledEvents: [], livemode: true }];

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('endpoint_not_found');
    expect(missingGauge()).toBe(HANDLED.length);
    expect(JSON.stringify(logger.error.mock.calls)).toContain('STRIPE_WEBHOOK_ENDPOINT_ID');
  });

  it('a configured id that does not exist is endpoint_not_found, not a crash', async () => {
    cfg.stripe.webhookEndpointId = 'we_gone';

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('endpoint_not_found');
    expect(missingGauge()).toBe(HANDLED.length);
  });

  it('a configured id that cannot be READ (network, permission) is lookup_failed, not not-found', async () => {
    cfg.stripe.webhookEndpointId = 'we_1';
    fake.retrieve.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('lookup_failed');
    expect(missingGauge()).toBe(HANDLED.length);
  });

  it('with neither an id nor a public URL, asks for the id', async () => {
    cfg.stripe.webhookUrl = '';

    const out = await reconcileStripeWebhookEvents(fake as never, HANDLED);

    expect(out.status).toBe('endpoint_not_found');
    expect(fake.list).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).toContain('STRIPE_WEBHOOK_ENDPOINT_ID');
  });
});

describe('the reconcile schedule', () => {
  it('is leader-locked, runs on start and re-checks daily', () => {
    startStripeWebhookReconcile(HANDLED);
    expect(start).toHaveBeenCalledTimes(1);
    expect(RECONCILE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(schedulerOpts).toMatchObject({ name: 'stripe-webhook-reconcile', intervalMs: RECONCILE_INTERVAL_MS, lock: { key: 'billing:stripe-webhook-reconcile:leader' } });
    stopStripeWebhookReconcile();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a cycle reconciles the active Stripe provider', async () => {
    startStripeWebhookReconcile(HANDLED);
    fake.endpoints = [{ id: 'we_1', url: URL, enabledEvents: [], livemode: true }];
    await schedulerOpts!.run();
    expect(fake.update).toHaveBeenCalledTimes(1);
  });

  it('a pod that lost the lock drops its copy of the gauge', () => {
    startStripeWebhookReconcile(HANDLED);
    gauges.set(WEBHOOK_EVENTS_MISSING_METRIC, 3);
    schedulerOpts!.onSkipped!();
    expect(missingGauge()).toBeUndefined();
  });

  it('does nothing unless the payment provider is Stripe', () => {
    cfg.billingProvider = 'stub';
    startStripeWebhookReconcile(HANDLED);
    expect(start).not.toHaveBeenCalled();
  });
});
