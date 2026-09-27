// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Getting a finished report to the people it was written for.
 *
 * The cases worth pinning are the ones where a delivery could go wrong QUIETLY:
 *
 *  - NO EMAIL CONFIGURED must not read as a successful send. Platform's mailer reports a
 *    disabled send as success, so without the status check every mail-less install would
 *    record reports as delivered to managers who never got them. The run says so in words
 *    a lead can act on.
 *  - AN UNDELIVERABLE RECIPIENT IS SKIPPED, not mailed. Unverified, unsubscribed and
 *    bouncing addresses each have their own reason, and the count of skips is reported.
 *  - A REFUSED RELAY IS NOT A BOUNCE. Counting a failed HTTP call as a bounce would retire
 *    a manager's address after three bad deploys.
 *  - `in-app` AND `email` ALERT DESTINATIONS ARE NOT FANNED OUT TO. Those channels are
 *    already covered above, and an org whose admins configured an email destination would
 *    otherwise receive the report twice, once without an unsubscribe link.
 *  - IN-APP GOES FIRST AND ALWAYS, so a report is never delivered nowhere.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSystemNotification = jest.fn<AnyFn>();
const mockGet = jest.fn<AnyFn>();
const mockPost = jest.fn<AnyFn>();
const mockWebhookDeliver = jest.fn<AnyFn>();
const mockDestinations = jest.fn<AnyFn>();
const mockGetRecipients = jest.fn<AnyFn>();
const mockRecordBounce = jest.fn<AnyFn>();
const mockDeliverability = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSystemNotification: (...a: unknown[]) => mockSystemNotification(...a),
  InternalHttpClient: class {
    get = (...a: unknown[]) => mockGet(...a);
    post = (...a: unknown[]) => mockPost(...a);
  },
  createWebhookChannel: () => ({ channel: 'webhook', deliver: (...a: unknown[]) => mockWebhookDeliver(...a) }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  MAX_BOUNCES: 3,
  listEnabledAlertDestinations: (...a: unknown[]) => mockDestinations(...a),
  stakeholderReportStore: {
    getRecipients: (...a: unknown[]) => mockGetRecipients(...a),
    recordBounce: (...a: unknown[]) => mockRecordBounce(...a),
    deliverability: (...a: unknown[]) => mockDeliverability(...a),
  },
}));

const delivery = await import('../src/services/report-delivery.js');

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  orgId: 'acme',
  ownerId: 'user-lead',
  name: 'Weekly delivery',
  cadence: 'weekly',
  recipients: ['rec-1'],
  ...over,
}) as never;

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  orgId: 'acme',
  periodLabel: '2026-W38',
  leadNotes: null,
  snapshot: { sections: [{ id: 'success_rate', headline: { label: 'Success rate', value: 94, unit: '%' } }] },
  ...over,
}) as never;

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1',
  orgId: 'acme',
  email: 'manager@acme.test',
  unsubscribeToken: 'u'.repeat(32),
  verifiedAt: new Date(),
  unsubscribedAt: null,
  bounceCount: 0,
  deletedAt: null,
  ...over,
});

/** The relay's answer to a report send. */
const relay = (sent: string[], failed: string[] = []) => ({ statusCode: 200, body: { data: { sent, failed } } });

beforeEach(() => {
  jest.clearAllMocks();
  delivery.resetEmailStatus();
  mockSystemNotification.mockResolvedValue(true);
  mockGet.mockResolvedValue({ statusCode: 200, body: { data: { enabled: true } } });
  mockPost.mockResolvedValue(relay(['manager@acme.test']));
  mockDestinations.mockResolvedValue([]);
  mockGetRecipients.mockResolvedValue([recipient()]);
  mockRecordBounce.mockResolvedValue(1);
  mockDeliverability.mockReturnValue({ deliverable: true });
  mockWebhookDeliver.mockResolvedValue({ ok: true, code: 200 });
});

describe('emailAvailable', () => {
  it('reports what platform says', async () => {
    await expect(delivery.emailAvailable()).resolves.toBe(true);
  });

  it('FAILS CLOSED when platform is unreachable', async () => {
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
    // Reading an outage as "email works" would record a send nobody can confirm happened.
    await expect(delivery.emailAvailable()).resolves.toBe(false);
  });

  it('fails closed on a non-2xx', async () => {
    mockGet.mockResolvedValue({ statusCode: 503, body: {} });
    await expect(delivery.emailAvailable()).resolves.toBe(false);
  });

  it('caches for a minute, then asks again', async () => {
    const t0 = 1_000_000;
    await delivery.emailAvailable(t0);
    await delivery.emailAvailable(t0 + 30_000);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await delivery.emailAvailable(t0 + 61_000);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});

describe('deliverPublishedRun', () => {
  it('posts in-app first, and counts it', async () => {
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.inApp).toBe(1);
    // The channel that cannot be misconfigured, so a report is never delivered nowhere.
    expect(mockSystemNotification.mock.invocationCallOrder[0])
      .toBeLessThan(mockPost.mock.invocationCallOrder[0] ?? Infinity);
  });

  it('notes an in-app failure rather than silently dropping it', async () => {
    mockSystemNotification.mockResolvedValue(false);
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.inApp).toBe(0);
    expect(outcome.notes.join(' ')).toContain('in-app notification could not be posted');
  });

  it('emails each verified recipient with their OWN unsubscribe link', async () => {
    await delivery.deliverPublishedRun(definition(), run());
    const body = mockPost.mock.calls[0]?.[1] as { reportRecipients: Array<{ email: string; unsubscribeUrl?: string }> };
    expect(body.reportRecipients).toHaveLength(1);
    // Per-address, each with its own link: a shared `to:` header would disclose every
    // address to all of them and could carry only one unsubscribe link.
    expect(body.reportRecipients[0]?.unsubscribeUrl).toContain('u'.repeat(32));
    expect(body.reportRecipients[0]?.unsubscribeUrl).toContain('/api/public/report-recipients/unsubscribe');
  });

  it('carries the headline and a LINK, never the numbers', async () => {
    await delivery.deliverPublishedRun(definition(), run());
    const body = mockPost.mock.calls[0]?.[1] as { text: string };
    expect(body.text).toContain('Success rate: 94%');
    expect(body.text).toContain('/reports?tab=stakeholder&run=run-1');
  });

  it('degrades to IN-APP ONLY when the instance cannot send mail', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { enabled: false } } });
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.emailAvailable).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
    expect(outcome.inApp).toBe(1);
    // Said in words a lead can act on, on the run itself.
    expect(outcome.notes.join(' ')).toContain('no outbound email configured');
    expect(outcome.notes.join(' ')).toContain('1 recipient');
  });

  it('says nothing about email when there was nobody to email', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { enabled: false } } });
    mockGetRecipients.mockResolvedValue([]);
    const outcome = await delivery.deliverPublishedRun(definition({ recipients: [] }), run());
    expect(outcome.notes).toEqual([]);
  });

  it('SKIPS an undeliverable recipient and counts the skip', async () => {
    mockGetRecipients.mockResolvedValue([recipient(), recipient({ id: 'rec-2', email: 'gone@acme.test' })]);
    mockDeliverability
      .mockReturnValueOnce({ deliverable: true })
      .mockReturnValueOnce({ deliverable: false, reason: 'unsubscribed' });
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.email.skipped).toBe(1);
    const body = mockPost.mock.calls[0]?.[1] as { reportRecipients: unknown[] };
    // An unsubscribe is honoured across every definition, so it has to be honoured here
    // rather than only in the UI that set it.
    expect(body.reportRecipients).toHaveLength(1);
  });

  it('records a bounce for each address the transport refused', async () => {
    mockPost.mockResolvedValue(relay([], ['manager@acme.test']));
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.email.failed).toBe(1);
    expect(mockRecordBounce).toHaveBeenCalledWith('acme', 'manager@acme.test');
  });

  it('warns once an address reaches the bounce ceiling', async () => {
    mockPost.mockResolvedValue(relay([], ['manager@acme.test']));
    mockRecordBounce.mockResolvedValue(3);
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.notes.join(' ')).toContain('bounced 3 times');
  });

  it('does NOT record a bounce when the relay itself refused the call', async () => {
    mockPost.mockResolvedValue({ statusCode: 503, body: {} });
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    // The addresses are fine and the relay is not. Counting this would retire a manager's
    // address after three bad deploys.
    expect(mockRecordBounce).not.toHaveBeenCalled();
    expect(outcome.email.sent).toBe(0);
    expect(outcome.email.failed).toBe(0);
  });

  it('does not record a bounce when the relay is unreachable', async () => {
    mockPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await delivery.deliverPublishedRun(definition(), run());
    expect(mockRecordBounce).not.toHaveBeenCalled();
  });

  it('fans out to slack and webhook destinations', async () => {
    mockDestinations.mockResolvedValue([
      { id: 'd1', channel: 'slack', target: 'https://hooks.slack.com/x', label: 'Eng' },
      { id: 'd2', channel: 'webhook', target: 'https://teams.example/hook', label: 'Teams' },
    ]);
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.destinations).toEqual({ delivered: 2, failed: 0 });
    const payload = (mockWebhookDeliver.mock.calls[0]?.[0] as { payload: { text: string } }).payload;
    // One payload serves both: Slack renders `text`, and so does a Teams incoming webhook
    // — which is why Teams needs no channel type of its own.
    expect(payload.text).toContain('Weekly delivery');
  });

  it('does NOT fan out to in-app or email destinations', async () => {
    mockDestinations.mockResolvedValue([
      { id: 'd1', channel: 'in-app', target: '', label: 'Inbox' },
      { id: 'd2', channel: 'email', target: 'ops@acme.test', label: 'Ops' },
    ]);
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    // Both channels are already covered; delivering again would send the report twice,
    // once without an unsubscribe link.
    expect(mockWebhookDeliver).not.toHaveBeenCalled();
    expect(outcome.destinations).toEqual({ delivered: 0, failed: 0 });
  });

  it('counts a failed destination without failing the delivery', async () => {
    mockDestinations.mockResolvedValue([{ id: 'd1', channel: 'slack', target: 'https://hooks.slack.com/x', label: 'Eng' }]);
    mockWebhookDeliver.mockResolvedValue({ ok: false, code: 404 });
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.destinations).toEqual({ delivered: 0, failed: 1 });
    expect(outcome.inApp).toBe(1);
  });

  it('survives a throwing destination transport', async () => {
    mockDestinations.mockResolvedValue([{ id: 'd1', channel: 'slack', target: 'https://hooks.slack.com/x', label: 'Eng' }]);
    mockWebhookDeliver.mockRejectedValue(new Error('socket hang up'));
    const outcome = await delivery.deliverPublishedRun(definition(), run());
    expect(outcome.destinations).toEqual({ delivered: 0, failed: 1 });
  });

  it('omits the unsubscribe link for a recipient minted without a token', async () => {
    mockGetRecipients.mockResolvedValue([recipient({ unsubscribeToken: null })]);
    await delivery.deliverPublishedRun(definition(), run());
    const body = mockPost.mock.calls[0]?.[1] as { reportRecipients: Array<Record<string, unknown>> };
    expect(body.reportRecipients[0]).not.toHaveProperty('unsubscribeUrl');
  });

  it('handles a snapshot with no comparable headline', async () => {
    await delivery.deliverPublishedRun(definition(), run({ snapshot: { sections: [{ id: 'top_failures' }] } }));
    const body = mockPost.mock.calls[0]?.[1] as { text: string };
    expect(body.text).toContain('Weekly delivery — 2026-W38');
  });

  it('includes the lead\'s own notes when there are any', async () => {
    await delivery.deliverPublishedRun(definition(), run({ leadNotes: 'We paused deploys Tuesday for the migration.' }));
    const body = mockPost.mock.calls[0]?.[1] as { text: string };
    // The context the data cannot supply, which is the whole reason a lead reviews.
    expect(body.text).toContain('paused deploys Tuesday');
  });
});

describe('notifyReadyForReview', () => {
  it('goes to the OWNER, not the org or the recipients', async () => {
    await delivery.notifyReadyForReview(definition(), run());
    expect(mockSystemNotification.mock.calls[0]?.[0]).toMatchObject({
      recipientOrgId: 'acme',
      recipientUserId: 'user-lead',
    });
  });

  it('emails the owner through the TENANT leg, not the report leg', async () => {
    await delivery.notifyReadyForReview(definition(), run());
    const body = mockPost.mock.calls[0]?.[1] as Record<string, unknown>;
    // The owner is a platform user, so platform resolves the address and reporting never
    // handles it.
    expect(body.targetUsers).toEqual(['user-lead']);
    expect(body).not.toHaveProperty('reportRecipients');
  });

  it('skips the email on a mail-less instance', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { enabled: false } } });
    await delivery.notifyReadyForReview(definition(), run());
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSystemNotification).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the owner email fails', async () => {
    mockPost.mockRejectedValue(new Error('smtp down'));
    await expect(delivery.notifyReadyForReview(definition(), run())).resolves.toBeUndefined();
  });
});

describe('notifyRunFailed', () => {
  it('tells the owner which period failed and why, at high priority', async () => {
    await delivery.notifyRunFailed(definition(), '2026-W38', 'past your retention horizon');
    const n = mockSystemNotification.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(n.recipientUserId).toBe('user-lead');
    expect(n.priority).toBe('high');
    expect(String(n.content)).toContain('past your retention horizon');
    // The schedule is unchanged, and saying so is what stops a lead going to look for a
    // broken configuration.
    expect(String(n.content)).toContain('schedule is unchanged');
  });
});

describe('notifyPaused', () => {
  it.each([
    ['entitlement', 'add-on is no longer active'],
    ['owner_inactive', 'no longer an active member'],
    ['permission_lost', 'no longer holds the permission'],
  ] as const)('names the cause for %s', async (reason, phrase) => {
    await delivery.notifyPaused(definition(), reason);
    const n = mockSystemNotification.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(n.content)).toContain(phrase);
    // To the ORG inbox, not just the owner: two of the three causes are things the owner
    // cannot fix, and one of them is that the owner is gone.
    expect(n.recipientUserId).toBeUndefined();
  });

  it('says published reports and links are unaffected', async () => {
    await delivery.notifyPaused(definition(), 'entitlement');
    const n = mockSystemNotification.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(n.content)).toContain('existing share links are unaffected');
  });
});
