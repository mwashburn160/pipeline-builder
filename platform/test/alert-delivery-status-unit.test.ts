// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for services/alert-delivery-status.ts with the models mocked —
 * the real-Mongo suite (alert-delivery-status.integration.test.ts) is gated,
 * so these pin the same behaviour in every default run: streak accounting,
 * the once-per-streak admin notice, the never-throw contract, the status view,
 * and the per-channel org gauges.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { queryChain } from './helpers/query-chain.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const statusUpdateOne = jest.fn<(...a: any[]) => Promise<any>>();
const statusFindOneAndUpdate = jest.fn<(...a: any[]) => any>();
const statusFind = jest.fn<(...a: any[]) => any>();
const statusAggregate = jest.fn<(...a: any[]) => Promise<any[]>>();

const orgFindById = jest.fn<(...a: any[]) => any>();
const userOrgFind = jest.fn<(...a: any[]) => any>();
const userFind = jest.fn<(...a: any[]) => any>();
const emailSend = jest.fn<(...a: any[]) => Promise<boolean>>();
const setGauge = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ app: { frontendUrl: 'https://app.test' } }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: () => undefined,
  setGauge: (...a: unknown[]) => setGauge(...a),
}));
jest.unstable_mockModule('../src/models/alert-destination-status.js', () => ({
  default: {
    updateOne: (...a: any[]) => statusUpdateOne(...a),
    findOneAndUpdate: (...a: any[]) => statusFindOneAndUpdate(...a),
    find: (...a: any[]) => statusFind(...a),
    aggregate: (...a: any[]) => statusAggregate(...a),
  },
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: any[]) => orgFindById(...a) },
  UserOrganization: { find: (...a: any[]) => userOrgFind(...a) },
  User: { find: (...a: any[]) => userFind(...a) },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => `oid:${id}` }));
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { send: (...a: any[]) => emailSend(...a) } }));
jest.unstable_mockModule('../src/utils/email-templates.js', () => ({
  alertDestinationFailingTemplate: (o: any) => ({ subject: `failing: ${o.destinationLabel}`, html: o.settingsUrl, text: String(o.failures) }),
}));

const svc = await import('../src/services/alert-delivery-status.js');
const { ALERT_CHANNELS } = await import('@pipeline-builder/api-core/wire-vocabulary');

const dest = { id: 'd-1', orgId: 'org-1', channel: 'slack', label: 'Ops Slack' };
const now = new Date('2026-01-01T00:00:00.000Z');

function failingStreak(consecutiveFailures: number, notifiedAt: Date | null = null) {
  statusFindOneAndUpdate.mockReturnValue(queryChain({ consecutiveFailures, notifiedAt }));
}

function orgWithAdmins(emails: Array<string | undefined>) {
  orgFindById.mockReturnValue(queryChain({ name: 'Acme' }));
  userOrgFind.mockReturnValue(queryChain(emails.map((_, i) => ({ userId: `u-${i}` }))));
  userFind.mockReturnValue(queryChain(emails.map((email) => ({ email }))));
}

beforeEach(() => {
  statusUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  statusFindOneAndUpdate.mockReset();
  statusFind.mockReset();
  statusAggregate.mockReset();
  orgFindById.mockReset();
  userOrgFind.mockReset();
  userFind.mockReset();
  emailSend.mockReset().mockResolvedValue(true);
  setGauge.mockReset();
});

describe('recordDeliveryOutcome', () => {
  it('a success upserts a reset status and sends nothing', async () => {
    await svc.recordDeliveryOutcome(dest, { ok: true }, now);
    expect(statusUpdateOne).toHaveBeenCalledWith(
      { destinationId: 'd-1' },
      { $set: expect.objectContaining({ lastOk: true, consecutiveFailures: 0, notifiedAt: null, lastSuccessAt: now }) },
      { upsert: true },
    );
    expect(statusFindOneAndUpdate).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('a failure below the threshold increments without notifying', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD - 1);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    const [, update] = statusFindOneAndUpdate.mock.calls[0];
    expect(update).toMatchObject({ $inc: { consecutiveFailures: 1 }, $set: { lastOk: false, lastErrorKind: 'rejected' } });
    expect(statusUpdateOne).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('does not notify again once the streak was already notified', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD + 1, now);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(statusUpdateOne).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('does not notify when the upsert returns nothing', async () => {
    statusFindOneAndUpdate.mockReturnValue(queryChain(null));
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'timeout' }, now);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('does not notify when another relay already claimed the notice', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    statusUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    orgWithAdmins(['boss@acme.com']);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(statusUpdateOne).toHaveBeenCalledWith({ destinationId: 'd-1', notifiedAt: null }, { $set: { notifiedAt: now } });
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('treats a missing modifiedCount as not claimed', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    statusUpdateOne.mockResolvedValue({});
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('emails the org admins once at the threshold', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    orgWithAdmins(['boss@acme.com', '', undefined, 'cto@acme.com']);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(orgFindById).toHaveBeenCalledWith('oid:org-1');
    expect(userOrgFind).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'oid:org-1', isActive: true }));
    expect(emailSend).toHaveBeenCalledTimes(1);
    const msg = emailSend.mock.calls[0][0] as any;
    expect(msg.to).toEqual(['boss@acme.com', 'cto@acme.com']);
    expect(msg.subject).toBe('failing: Ops Slack');
    expect(msg.html).toBe('https://app.test/dashboard/observability/alert-destinations');
  });

  it('labels the notice with the channel when the destination has no label', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    orgWithAdmins(['boss@acme.com']);
    orgFindById.mockReturnValue(queryChain({}));
    await svc.recordDeliveryOutcome({ id: 'd-2', orgId: 'org-1', channel: 'webhook' }, { ok: false, kind: 'rejected' }, now);
    expect((emailSend.mock.calls[0][0] as any).subject).toBe('failing: webhook');
  });

  it('sends nothing when the org is gone', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    orgWithAdmins(['boss@acme.com']);
    orgFindById.mockReturnValue(queryChain(null));
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(userFind).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('sends nothing when the org has no admins', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    orgWithAdmins([]);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(userFind).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('sends nothing when no admin has an email address', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    orgWithAdmins(['', undefined]);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('swallows a failed notice', async () => {
    failingStreak(svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD);
    orgWithAdmins(['boss@acme.com']);
    emailSend.mockRejectedValue(new Error('ses down'));
    await expect(svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, now)).resolves.toBeUndefined();
  });

  it('never throws when the status write fails', async () => {
    statusUpdateOne.mockRejectedValue(new Error('mongo down'));
    await expect(svc.recordDeliveryOutcome(dest, { ok: true })).resolves.toBeUndefined();
  });
});

describe('deliveryStatusesFor', () => {
  it('returns an empty map without querying for no ids', async () => {
    const out = await svc.deliveryStatusesFor([]);
    expect(out.size).toBe(0);
    expect(statusFind).not.toHaveBeenCalled();
  });

  it('maps rows to the view shape', async () => {
    statusFind.mockReturnValue(queryChain([
      {
        destinationId: 'd-1',
        lastAttemptAt: now,
        lastOk: false,
        lastErrorKind: 'timeout',
        lastSuccessAt: null,
        lastFailureAt: now,
        consecutiveFailures: 2,
      },
      { destinationId: 'd-2', lastAttemptAt: now, lastOk: true, lastSuccessAt: now, consecutiveFailures: 0 },
    ]));
    const out = await svc.deliveryStatusesFor(['d-1', 'd-2', 'd-3']);
    expect(statusFind).toHaveBeenCalledWith({ destinationId: { $in: ['d-1', 'd-2', 'd-3'] } });
    expect(out.get('d-1')).toEqual({
      lastAttemptAt: now.toISOString(),
      lastOk: false,
      lastErrorKind: 'timeout',
      lastSuccessAt: null,
      lastFailureAt: now.toISOString(),
      consecutiveFailures: 2,
    });
    expect(out.get('d-2')).toMatchObject({ lastOk: true, lastErrorKind: null, lastSuccessAt: now.toISOString(), lastFailureAt: null });
    expect(out.has('d-3')).toBe(false);
  });
});

describe('publishDeliveryHealth', () => {
  it('counts orgs per channel and publishes every known channel', async () => {
    statusAggregate.mockResolvedValue([
      { _id: { channel: 'slack', orgId: 'a' }, failing: true },
      { _id: { channel: 'slack', orgId: 'b' }, failing: false },
      { _id: { channel: 'custom-x', orgId: 'a' }, failing: false },
    ]);
    const out = await svc.publishDeliveryHealth(now);
    expect(out).toEqual({ 'slack': { attempted: 2, failing: 1 }, 'custom-x': { attempted: 1, failing: 0 } });
    const pipeline = statusAggregate.mock.calls[0][0] as any[];
    expect(pipeline[0].$match.lastAttemptAt.$gte).toEqual(new Date(now.getTime() - svc.DELIVERY_HEALTH_WINDOW_MS));
    expect(setGauge).toHaveBeenCalledWith('alert_destination_orgs', { channel: 'slack', state: 'failing' }, 1);
    expect(setGauge).toHaveBeenCalledWith('alert_destination_orgs', { channel: 'custom-x', state: 'attempted' }, 1);
    const channels = new Set([...ALERT_CHANNELS, 'slack', 'custom-x']);
    expect(setGauge).toHaveBeenCalledTimes(channels.size * 2);
    for (const c of ALERT_CHANNELS) {
      if (c === 'slack') continue;
      expect(setGauge).toHaveBeenCalledWith('alert_destination_orgs', { channel: c, state: 'attempted' }, 0);
    }
  });

  it('propagates a read failure', async () => {
    statusAggregate.mockRejectedValue(new Error('boom'));
    await expect(svc.publishDeliveryHealth()).rejects.toThrow('boom');
  });
});

describe('deliveryHealthSweep', () => {
  it('defaults the interval and runs the publisher', async () => {
    statusAggregate.mockResolvedValue([]);
    const sweep = svc.deliveryHealthSweep();
    expect(sweep).toMatchObject({ name: 'alert-delivery-health', intervalMs: svc.DELIVERY_HEALTH_INTERVAL_MS });
    await sweep.run({} as never);
    expect(statusAggregate).toHaveBeenCalledTimes(1);
  });

  it('honours a custom interval', () => {
    expect(svc.deliveryHealthSweep(1000).intervalMs).toBe(1000);
  });
});
