// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/alert-relay.ts — the Alertmanager fan-out: one webhook, every org's
 * matching destinations. Pins the counting (delivered / skipped / failed), the
 * severity → destination tier mapping, the message each channel receives, and
 * that every REAL attempt (not a skip) records its outcome for the
 * destinations list — with the error CLASS (unknown channel, rejected,
 * timeout, unreachable), never the downstream detail.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

const findForDelivery = jest.fn<(orgId: string, tier: string) => Promise<unknown[]>>();
const recordDeliveryOutcome = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const deliver = jest.fn<(msg: any, target: any, signal: AbortSignal) => Promise<any>>();
const incCounter = jest.fn();

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ observability: { alertDeliveryTimeoutMs: 20 } }));
jest.unstable_mockModule('../src/services/alert-destination-service.js', () => ({ alertDestinationService: { findForDelivery: (o: string, t: string) => findForDelivery(o, t) } }));
jest.unstable_mockModule('../src/services/alert-delivery-status.js', () => ({ recordDeliveryOutcome: (...a: unknown[]) => recordDeliveryOutcome(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => incCounter(...a) }));
const realChannels = await import('../src/services/notification-channels.js');
jest.unstable_mockModule('../src/services/notification-channels.js', () => ({
  ...realChannels,
  getNotificationChannel: (name: string) => (name === 'fax' ? null : { channel: name, deliver }),
}));

const { relayWebhook } = await import('../src/services/alert-relay.js');

const dest = (id: string, channel = 'slack') => ({ id, orgId: 'org-a', channel, target: 'https://hooks.test/x', label: id });
const alert = (labels: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  status: 'firing' as const,
  labels,
  annotations: { summary: 'disk full', description: 'it is full' },
  startsAt: '2026-01-01T00:00:00Z',
  endsAt: '',
  fingerprint: 'fp-1',
  ...extra,
});
const payload = (...alerts: ReturnType<typeof alert>[]) => ({
  version: '4' as const,
  groupKey: 'g',
  status: 'firing' as const,
  receiver: 'ops-center-relay',
  groupLabels: {},
  commonLabels: {},
  commonAnnotations: {},
  alerts,
});

beforeEach(() => {
  findForDelivery.mockReset().mockResolvedValue([dest('d1')]);
  recordDeliveryOutcome.mockClear();
  deliver.mockReset().mockResolvedValue({ ok: true });
  incCounter.mockClear();
});

describe('relayWebhook', () => {
  it('skips an alert with no org_id, and an org with no matching destination', async () => {
    findForDelivery.mockResolvedValueOnce([]);
    const res = await relayWebhook(payload(alert({ alertname: 'A' }), alert({ alertname: 'B', org_id: 'org-a' })));
    expect(res).toEqual({ delivered: 0, skipped: 2, failed: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('routes critical to the critical tier and anything else to warning', async () => {
    await relayWebhook(payload(alert({ org_id: 'org-a', severity: 'critical' }), alert({ org_id: 'org-a', severity: 'info' })));
    expect(findForDelivery.mock.calls.map((c) => c[1])).toEqual(['critical', 'warning']);
  });

  it('delivers the rendered alert to each destination and records the success', async () => {
    findForDelivery.mockResolvedValue([dest('d1'), dest('d2', 'webhook')]);
    const res = await relayWebhook(payload(alert({ org_id: 'org-a', alertname: 'DiskFull', severity: 'critical' })));
    expect(res).toEqual({ delivered: 2, skipped: 0, failed: 0 });
    const [msg, target] = deliver.mock.calls[0]!;
    expect(msg).toMatchObject({ recipientOrgId: 'org-a', subject: '[CRITICAL] DiskFull', priority: 'urgent', dedupeKey: 'fp-1', messageType: 'announcement' });
    expect(target).toEqual({ value: 'https://hooks.test/x', orgId: 'org-a' });
    expect(recordDeliveryOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), { ok: true });
    expect(incCounter).toHaveBeenCalledWith('alert_notification_delivery', { channel: 'slack', result: 'delivered' });
  });

  it('defaults the title when the alert has no alertname', async () => {
    await relayWebhook(payload(alert({ org_id: 'org-a' }, { annotations: {} })));
    expect(deliver.mock.calls[0]![0]).toMatchObject({ title: 'Alert', summary: '' });
  });

  it('counts a skip without recording it, and a non-ok as rejected', async () => {
    deliver.mockResolvedValueOnce({ ok: false, skipped: true, error: 'email-disabled' });
    deliver.mockResolvedValueOnce({ ok: false, code: 'HTTP_500', error: 'nope' });
    findForDelivery.mockResolvedValue([dest('d1'), dest('d2')]);
    const res = await relayWebhook(payload(alert({ org_id: 'org-a' })));
    expect(res).toEqual({ delivered: 0, skipped: 1, failed: 1 });
    expect(recordDeliveryOutcome).toHaveBeenCalledTimes(1);
    expect(recordDeliveryOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2' }), { ok: false, kind: 'rejected' });
  });

  it('records an unknown channel, a timeout and a transport failure by class', async () => {
    findForDelivery.mockResolvedValue([dest('d-fax', 'fax'), dest('d-slow'), dest('d-down')]);
    deliver
      .mockImplementationOnce((_m, _t, signal) => new Promise((_r, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await relayWebhook(payload(alert({ org_id: 'org-a' })));
    expect(res).toEqual({ delivered: 0, skipped: 0, failed: 3 });
    expect(recordDeliveryOutcome.mock.calls.map((c) => c[1])).toEqual([
      { ok: false, kind: 'unknown-channel' },
      { ok: false, kind: 'timeout' },
      { ok: false, kind: 'unreachable' },
    ]);
  });

  it('counts a destination lookup failure and a delivery that throws past its own handler', async () => {
    findForDelivery.mockRejectedValueOnce(new Error('db down'));
    recordDeliveryOutcome.mockRejectedValueOnce(new Error('never throws in prod'));
    const res = await relayWebhook(payload(alert({ org_id: 'org-a' }), alert({ org_id: 'org-a' })));
    expect(res).toEqual({ delivered: 0, skipped: 0, failed: 2 });
  });
});
