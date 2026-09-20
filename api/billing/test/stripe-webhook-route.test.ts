// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `routes/stripe-webhook.ts` — the money path's front door.
 *
 * `stripe-webhook.test.ts` next door exercises the HANDLERS directly: its
 * provider double is deliberately not a `StripeProvider`, so every request it
 * makes stops at the first `instanceof` guard and the dispatcher itself was
 * never run. This suite drives the route for real, with a provider that IS one,
 * and asserts the three things only the route decides:
 *
 *   - NOTHING is processed unsigned — no Stripe provider, no webhook secret, no
 *     signature header and a failed `constructEvent` each refuse BEFORE the
 *     idempotency claim is taken, so a forged payload cannot even burn an event
 *     id;
 *   - the two-phase claim: a duplicate delivery short-circuits with 200 and runs
 *     no side-effect, the durable done-marker is written only after the handler
 *     succeeds, and a failed handler RELEASES the claim so Stripe's retry
 *     re-runs it rather than being deduped into silence;
 *   - the dispatch table: every event type Stripe sends reaches exactly one
 *     handler, and a type we do not model is ignored with a 200 rather than
 *     retried forever against a 500.
 *
 * Billing's inline module mocks are the documented exception to the
 * spread-the-real-module rule — see `test/helpers/mock-api-core.ts` for why
 * `requireActual` cannot work in this project.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const sent: Array<{ kind: 'success' | 'error'; status: number; body: unknown; code?: string }> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (_res: unknown, status: number, data: unknown) => { sent.push({ kind: 'success', status, body: data }); },
  sendError: (_res: unknown, status: number, message: string, code?: string) => {
    sent.push({ kind: 'error', status, body: message, code });
  },
}));

// -- The event handlers: this suite asserts the DISPATCH, not their behaviour --
const handler = () => jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const h = {
  subCreated: handler(),
  subUpdated: handler(),
  subDeleted: handler(),
  paid: handler(),
  failed: handler(),
  upcoming: handler(),
  refunded: handler(),
  disputed: handler(),
  reversal: handler(),
};
jest.unstable_mockModule('../src/helpers/stripe-subscription-handlers.js', () => ({
  handleSubscriptionCreated: (...a: unknown[]) => h.subCreated(...a),
  handleSubscriptionUpdated: (...a: unknown[]) => h.subUpdated(...a),
  handleSubscriptionDeleted: (...a: unknown[]) => h.subDeleted(...a),
}));
jest.unstable_mockModule('../src/helpers/stripe-invoice-handlers.js', () => ({
  handlePaymentSucceeded: (...a: unknown[]) => h.paid(...a),
  handlePaymentFailed: (...a: unknown[]) => h.failed(...a),
  handleInvoiceUpcoming: (...a: unknown[]) => h.upcoming(...a),
}));
jest.unstable_mockModule('../src/helpers/stripe-reversals.js', () => ({
  handleChargeRefunded: (...a: unknown[]) => h.refunded(...a),
  handleChargeDisputeCreated: (...a: unknown[]) => h.disputed(...a),
  handleInvoiceReversal: (...a: unknown[]) => h.reversal(...a),
}));

// -- The idempotency store --
const mockClaim = jest.fn<(...a: unknown[]) => Promise<string | null>>();
const mockMarkDone = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockRelease = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/models/webhook-dedupe.js', () => ({
  claimWebhookEvent: (...a: unknown[]) => mockClaim(...a),
  markWebhookEventDone: (...a: unknown[]) => mockMarkDone(...a),
  releaseWebhookEvent: (...a: unknown[]) => mockRelease(...a),
}));

// -- The provider. The route's `instanceof StripeProvider` guard means the
//    factory must hand back an instance of the SAME class the route imports, so
//    the class is defined here and both mocks close over it.
class FakeStripeProvider {
  getWebhookSecret(): string | undefined { return webhookSecret; }
  getStripeClient(): unknown {
    return { webhooks: { constructEvent: (...a: unknown[]) => mockConstructEvent(...a) } };
  }
}
let webhookSecret: string | undefined = 'whsec_test';
let activeProvider: unknown = new FakeStripeProvider();
const mockConstructEvent = jest.fn<(...a: unknown[]) => any>();

jest.unstable_mockModule('../src/providers/stripe-provider.js', () => ({ StripeProvider: FakeStripeProvider }));
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({ getPaymentProvider: () => activeProvider }));

const { createStripeWebhookRoutes } = await import('../src/routes/stripe-webhook.js');

let route: (req: unknown, res: unknown) => Promise<unknown>;
beforeAll(() => {
  const router = createStripeWebhookRoutes() as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<unknown> }> } }>;
  };
  route = router.stack.find((l) => l.route?.path === '/stripe/webhook')!.route!.stack[0].handle;
});

/** Deliver a raw body with whatever `constructEvent` is currently set to return. */
async function deliver(over: Record<string, unknown> = {}): Promise<void> {
  await route({ headers: { 'stripe-signature': 'sig_test' }, body: Buffer.from('{}'), ...over }, {});
}

/** Deliver a well-formed signed event of `type`. */
async function deliverEvent(type: string, object: unknown = { id: 'obj_1' }, id = 'evt_1'): Promise<void> {
  mockConstructEvent.mockReturnValue({ id, type, data: { object } });
  await deliver();
}

const last = () => sent[sent.length - 1];
const handlerCalls = () => Object.entries(h).filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);

beforeEach(() => {
  jest.clearAllMocks();
  sent.length = 0;
  webhookSecret = 'whsec_test';
  activeProvider = new FakeStripeProvider();
  mockClaim.mockResolvedValue('claim-token');
  mockMarkDone.mockResolvedValue(undefined);
  mockRelease.mockResolvedValue(undefined);
});

describe('nothing is processed unsigned', () => {
  it('refuses when the active provider is not Stripe', async () => {
    activeProvider = { name: 'paypal' };
    await deliver();
    expect(last()).toMatchObject({ kind: 'error', status: 400, body: 'Stripe provider is not configured' });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('refuses with 503 when no webhook secret is configured, so Stripe RETRIES the misconfiguration', async () => {
    // A 200 here would silently discard live billing events; a 400 would make
    // Stripe give up. 503 is the one answer that survives the fix.
    webhookSecret = undefined;
    await deliver();
    expect(last()).toMatchObject({ kind: 'error', status: 503 });
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('refuses a delivery with no signature header', async () => {
    await deliver({ headers: {} });
    expect(last()).toMatchObject({ kind: 'error', status: 400, body: 'Missing Stripe signature header' });
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('refuses a payload whose signature does not verify — before any event id is claimed', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('No signatures found matching the expected signature'); });

    await deliver();

    expect(last()).toMatchObject({ kind: 'error', status: 400, body: 'Invalid webhook signature' });
    // Burning the id here would let a forged payload dedupe the REAL delivery.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(handlerCalls()).toEqual([]);
  });

  it('verifies against the raw body and the configured secret', async () => {
    const body = Buffer.from('{"id":"evt_1"}');
    mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'invoice.upcoming', data: { object: {} } });

    await deliver({ body });

    expect(mockConstructEvent).toHaveBeenCalledWith(body, 'sig_test', 'whsec_test');
  });
});

describe('the two-phase idempotency claim', () => {
  it('runs the handler, THEN writes the durable done-marker', async () => {
    await deliverEvent('invoice.payment_succeeded');

    expect(mockClaim).toHaveBeenCalledWith('stripe', 'evt_1');
    expect(h.paid).toHaveBeenCalledWith({ id: 'obj_1' });
    expect(mockMarkDone).toHaveBeenCalledWith('stripe', 'evt_1');
    expect(last()).toEqual({ kind: 'success', status: 200, body: { received: true } });
  });

  it('short-circuits a duplicate delivery with 200 and NO side-effect', async () => {
    mockClaim.mockResolvedValue(null);

    await deliverEvent('customer.subscription.created');

    // Replaying `customer.subscription.created` would provision a second
    // subscription and charge for it.
    expect(handlerCalls()).toEqual([]);
    expect(mockMarkDone).not.toHaveBeenCalled();
    expect(last()).toEqual({ kind: 'success', status: 200, body: { received: true, duplicate: true } });
  });

  it('RELEASES the claim when a handler fails, so Stripe\'s retry re-runs the event', async () => {
    h.paid.mockRejectedValueOnce(new Error('quota service unreachable'));

    await deliverEvent('invoice.payment_succeeded', { id: 'in_1' }, 'evt_boom');

    expect(mockRelease).toHaveBeenCalledWith('stripe', 'evt_boom', 'claim-token');
    // Leaving the claim would make every retry look like a duplicate and drop a
    // paid invoice on the floor.
    expect(mockMarkDone).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ kind: 'error', status: 500, body: 'Failed to process webhook event' });
  });

  it('still answers 500 when the release itself fails — the release is best-effort', async () => {
    h.failed.mockRejectedValueOnce(new Error('downstream down'));
    mockRelease.mockRejectedValueOnce(new Error('redis down'));

    await deliverEvent('invoice.payment_failed');

    expect(last()).toMatchObject({ kind: 'error', status: 500 });
  });
});

describe('the dispatch table', () => {
  it.each([
    ['customer.subscription.created', 'subCreated'],
    ['customer.subscription.updated', 'subUpdated'],
    ['customer.subscription.deleted', 'subDeleted'],
    ['invoice.payment_succeeded', 'paid'],
    ['invoice.payment_failed', 'failed'],
    ['invoice.upcoming', 'upcoming'],
    ['charge.refunded', 'refunded'],
    ['charge.dispute.created', 'disputed'],
  ] as const)('routes %s to exactly one handler, with the event object', async (type, name) => {
    await deliverEvent(type, { id: 'obj_x' });

    expect(handlerCalls()).toEqual([name]);
    expect(h[name]).toHaveBeenCalledWith({ id: 'obj_x' });
    expect(mockMarkDone).toHaveBeenCalled();
    expect(last()).toEqual({ kind: 'success', status: 200, body: { received: true } });
  });

  it.each([
    ['invoice.voided', 'invoice_voided'],
    ['invoice.marked_uncollectible', 'invoice_uncollectible'],
  ] as const)('routes %s to the ledger reversal with its own reason', async (type, reason) => {
    await deliverEvent(type, { id: 'in_9' });

    expect(handlerCalls()).toEqual(['reversal']);
    // The reason is what the ledger row records — swapping the two would
    // mislabel every reversal.
    expect(h.reversal).toHaveBeenCalledWith({ id: 'in_9' }, reason);
  });

  it('IGNORES an event type we do not model, rather than 500ing it into a retry loop', async () => {
    await deliverEvent('customer.source.expiring');

    expect(handlerCalls()).toEqual([]);
    // Still marked done: Stripe sends dozens of types we never subscribe to and
    // a permanent 500 on each would drown the retry queue.
    expect(mockMarkDone).toHaveBeenCalledWith('stripe', 'evt_1');
    expect(last()).toEqual({ kind: 'success', status: 200, body: { received: true } });
  });
});
