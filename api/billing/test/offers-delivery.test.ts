// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3's two delivery legs (docs/plans/sales-agent.md).
 *
 * The consent check is asserted as "no network call happened at all" rather than
 * "it returned false": platform does NOT re-check either switch — it owns
 * neither — so if this short-circuit is ever lost, nothing downstream stops the
 * mail, and a test that only inspected the return value would still pass.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-offers-delivery';

const mockNotify = jest.fn<AnyFn>();
const mockPost = jest.fn<AnyFn>();
const mockCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSystemNotification: mockNotify,
  emitCounter: mockCounter,
  createSafeClient: () => ({ post: mockPost }),
  serviceEndpoint: () => ({ host: 'platform', port: 3000 }),
  getServiceAuthHeader: () => 'Bearer svc',
}));

const { deliverOffer } = await import('../src/helpers/offers-notify.js');

type Facts = Parameters<typeof deliverOffer>[0]['facts'];

const FACTS: Facts = {
  offerType: 'pack',
  pressure: [{ dimension: 'pipelines', used: 9, limit: 10 }],
  pack: { name: 'Pipeline pack', priceCents: 1199, grantDisplay: '10' },
  interval: 'monthly',
};

const BOTH_ON = { accountOptIn: true, noticesEnabled: true };

/** The outcomes recorded on the email counter, for the per-reason assertions. */
function emailOutcomes(): string[] {
  return mockCounter.mock.calls
    .filter((c) => c[0] === 'billing_offer_emails_total')
    .map((c) => (c[1] as { outcome: string }).outcome);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNotify.mockResolvedValue(true);
  mockPost.mockResolvedValue({ statusCode: 200, body: { data: { recipientCount: 2 } } });
});

describe('the consent AND is enforced HERE or nowhere', () => {
  it('sends on NEITHER surface when the account opted out of offers', async () => {
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: { accountOptIn: false, noticesEnabled: true }, facts: FACTS });
    expect(out).toEqual({ inApp: false, email: 'consent' });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('sends on NEITHER surface when quota notices are off — the channel is off', async () => {
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: { accountOptIn: true, noticesEnabled: false }, facts: FACTS });
    expect(out.email).toBe('consent');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('counts a consent suppression on BOTH counters, so neither looks like an outage', async () => {
    await deliverOffer({ rootOrgId: 'acct-1', consent: { accountOptIn: false, noticesEnabled: false }, facts: FACTS });
    const names = mockCounter.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['billing_offer_notices_total', 'billing_offer_emails_total']);
    expect(emailOutcomes()).toEqual(['consent']);
  });
});

describe('unpriceable copy is refused on both surfaces', () => {
  it('sends nothing when the facts cannot name a price', async () => {
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: { ...FACTS, pack: null } });
    expect(out).toEqual({ inApp: false, email: 'no_copy' });
    // The inbox copy is the SAME sentence as the mail, so it is no better
    // without a price — hence neither leg goes out.
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('the two surfaces', () => {
  it('drops the inbox notice first, then mails', async () => {
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    expect(out).toEqual({ inApp: true, email: 'sent' });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('never borrows the priority a breached cap uses', async () => {
    await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({ recipientOrgId: 'acct-1', priority: 'normal' });
  });

  it('mails on the OFFER leg, tenant-bound to the account it is about', async () => {
    await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    const [path, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/internal/notify-email');
    expect(body).toMatchObject({ offerNotice: true, orgId: 'acct-1' });
    expect(body.text).toContain('$11.99');
  });

  it('reports the inbox landing even when the relay is down', async () => {
    // A real and common state. Collapsing the two would make it
    // indistinguishable from an account that heard nothing at all.
    mockPost.mockResolvedValue({ statusCode: 503, body: {} });
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    expect(out).toEqual({ inApp: true, email: 'failed' });
  });

  it('treats a transport failure (null) as a failed send, not a sent one', async () => {
    mockPost.mockResolvedValue(null);
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    expect(out.email).toBe('failed');
  });

  it('never throws when the relay rejects', async () => {
    mockPost.mockRejectedValue(new Error('ECONNRESET'));
    await expect(deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS })).resolves.toMatchObject({ email: 'failed' });
  });

  it('distinguishes "nobody to mail" from a broken send', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { recipientCount: 0 } } });
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    expect(out.email).toBe('no_recipients');
  });

  it('reports a failed inbox notice without losing the mail', async () => {
    mockNotify.mockResolvedValue(false);
    const out = await deliverOffer({ rootOrgId: 'acct-1', consent: BOTH_ON, facts: FACTS });
    expect(out).toEqual({ inApp: false, email: 'sent' });
  });
});
