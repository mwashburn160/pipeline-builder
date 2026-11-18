// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/alert-delivery-status.ts against a REAL Postgres (PGlite + the
 * shipped init script, as the app role under FORCE'd RLS).
 *
 * The status lived in a Mongo collection with a TTL index while this code was
 * platform's; ops-center keeps it in the Postgres `alert_destination_status`
 * table instead (no Mongo connection here). This suite pins the behaviour that
 * move had to preserve: the failure streak, the ONE notice to the org's admins
 * per streak (claimed atomically), the reset on success, the destinations-list
 * view, the per-channel org gauges, the never-throw contract, and the 30-day
 * retention the TTL index used to do.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { mockConfig } from './helpers/config-mock.js';

process.env.JWT_SECRET ||= 'alert-delivery-status-test-secret';

const notifyOrgAdmins = jest.fn<(o: { orgId: string; subject: string; text: string }) => Promise<boolean>>(async () => true);
const setGauge = jest.fn();
jest.unstable_mockModule('../src/services/platform-client.js', () => ({ notifyOrgAdmins: (o: never) => notifyOrgAdmins(o) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: () => undefined, setGauge: (...a: unknown[]) => setGauge(...a) }));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ app: { frontendUrl: 'https://app.test' } }));

const svc = await import('../src/services/alert-delivery-status.js');

let tdb: TenantTestDb;
const ORG = 'org-a';
const dest = { id: 'd-1', orgId: ORG, channel: 'slack', label: 'Ops Slack' };

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await tdb.asOwner((q) => q.exec('DELETE FROM alert_destination_status;'));
  notifyOrgAdmins.mockClear().mockResolvedValue(true);
  setGauge.mockClear();
});

const row = (id = dest.id) => tdb.asOwner(async (q) => (await q.query<Record<string, unknown>>(
  'SELECT * FROM alert_destination_status WHERE destination_id = $1', [id])).rows[0]);

describe('recordDeliveryOutcome', () => {
  it('counts a failure streak, tells the admins ONCE at the threshold, and resets on success', async () => {
    const t = new Date('2026-01-01T00:00:00.000Z');
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, t);
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, t);
    expect(notifyOrgAdmins).not.toHaveBeenCalled();
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'timeout' }, t);
    expect(notifyOrgAdmins).toHaveBeenCalledTimes(1);
    const notice = notifyOrgAdmins.mock.calls[0]![0];
    expect(notice.orgId).toBe(ORG);
    expect(notice.subject).toBe('Alert destination "Ops Slack" is failing');
    expect(notice.text).toContain('the last 3 times');
    expect(notice.text).toContain('(reason: timeout)');
    expect(notice.text).toContain('https://app.test/dashboard/observability/alert-destinations');

    // Already notified this streak: a fourth failure sends nothing more.
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'timeout' }, t);
    expect(notifyOrgAdmins).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({ consecutive_failures: 4, last_ok: false, last_error_kind: 'timeout' });

    // A success resets the streak and re-arms the notice.
    await svc.recordDeliveryOutcome(dest, { ok: true }, t);
    expect(await row()).toMatchObject({ consecutive_failures: 0, last_ok: true, last_error_kind: null, notified_at: null });
    for (let i = 0; i < 3; i++) await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'unreachable' }, t);
    expect(notifyOrgAdmins).toHaveBeenCalledTimes(2);
  });

  it('labels the notice with the channel when the destination has no label', async () => {
    const unlabeled = { id: 'd-2', orgId: ORG, channel: 'webhook' };
    for (let i = 0; i < 3; i++) await svc.recordDeliveryOutcome(unlabeled, { ok: false, kind: 'rejected' });
    expect(notifyOrgAdmins.mock.calls[0]![0].subject).toBe('Alert destination "webhook" is failing');
  });

  it('records the streak even when the notice could not be sent', async () => {
    notifyOrgAdmins.mockResolvedValue(false);
    for (let i = 0; i < 3; i++) await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' });
    expect(await row()).toMatchObject({ consecutive_failures: 3 });
    expect((await row())!.notified_at).not.toBeNull();
  });

  it('never throws when the status write fails', async () => {
    // A channel name longer than the column is refused by Postgres.
    await expect(svc.recordDeliveryOutcome({ ...dest, channel: 'x'.repeat(50) }, { ok: true })).resolves.toBeUndefined();
    await expect(svc.recordDeliveryOutcome({ ...dest, channel: 'x'.repeat(50) }, { ok: false, kind: 'rejected' })).resolves.toBeUndefined();
  });
});

describe('deliveryStatusesFor', () => {
  it('returns an empty map for no ids, and maps rows to the view shape', async () => {
    expect((await svc.deliveryStatusesFor([])).size).toBe(0);
    const t = new Date('2026-02-01T00:00:00.000Z');
    await svc.recordDeliveryOutcome(dest, { ok: false, kind: 'rejected' }, t);
    const view = await svc.deliveryStatusesFor([dest.id, 'never-tried']);
    expect(view.has('never-tried')).toBe(false);
    expect(view.get(dest.id)).toEqual({
      lastAttemptAt: t.toISOString(),
      lastOk: false,
      lastErrorKind: 'rejected',
      lastSuccessAt: null,
      lastFailureAt: t.toISOString(),
      consecutiveFailures: 1,
    });
  });
});

describe('publishDeliveryHealth', () => {
  it('counts orgs per channel (failing = the org\'s last attempt on it failed) and publishes every channel', async () => {
    const now = new Date();
    await svc.recordDeliveryOutcome({ id: 'a1', orgId: 'org-a', channel: 'slack' }, { ok: false, kind: 'rejected' }, now);
    await svc.recordDeliveryOutcome({ id: 'a2', orgId: 'org-a', channel: 'slack' }, { ok: true }, now);
    await svc.recordDeliveryOutcome({ id: 'b1', orgId: 'org-b', channel: 'slack' }, { ok: true }, now);
    // Outside the window: not counted.
    await svc.recordDeliveryOutcome({ id: 'c1', orgId: 'org-c', channel: 'slack' }, { ok: false, kind: 'rejected' }, new Date(now.getTime() - 2 * 60 * 60 * 1000));

    const byChannel = await svc.publishDeliveryHealth(now);
    expect(byChannel.slack).toEqual({ attempted: 2, failing: 1 });
    expect(setGauge).toHaveBeenCalledWith('alert_destination_orgs', { channel: 'slack', state: 'failing' }, 1);
    expect(setGauge).toHaveBeenCalledWith('alert_destination_orgs', { channel: 'email', state: 'attempted' }, 0);
  });
});

describe('retention', () => {
  it('drops a status nothing has tried for 30 days, keeping the rest', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    await svc.recordDeliveryOutcome({ id: 'old', orgId: ORG, channel: 'slack' }, { ok: true }, new Date(now.getTime() - svc.DESTINATION_STATUS_TTL_MS - 1000));
    await svc.recordDeliveryOutcome({ id: 'fresh', orgId: ORG, channel: 'slack' }, { ok: true }, now);
    expect(await svc.pruneStaleDeliveryStatus(now)).toBe(1);
    expect(await row('old')).toBeUndefined();
    expect(await row('fresh')).toBeDefined();
  });
});

describe('sweep definitions', () => {
  it('the health sweep runs on every replica and publishes', async () => {
    const def = svc.deliveryHealthSweep();
    expect(def).toMatchObject({ name: 'alert-delivery-health', intervalMs: svc.DELIVERY_HEALTH_INTERVAL_MS });
    expect('lockKey' in def && def.lockKey).toBeFalsy();
    await def.run({ signal: new AbortController().signal });
    expect(setGauge).toHaveBeenCalled();
    expect(svc.deliveryHealthSweep(1234).intervalMs).toBe(1234);
  });

  it('the retention sweep is leader-locked and concurrency-safe', async () => {
    const def = svc.deliveryStatusRetentionSweep(5000);
    expect(def).toMatchObject({ name: 'alert-delivery-status-retention', intervalMs: 5000, concurrencySafe: true });
    expect(def.lockKey).toContain('ops-center');
    await svc.recordDeliveryOutcome({ id: 'ancient', orgId: ORG, channel: 'slack' }, { ok: true }, new Date('2000-01-01T00:00:00.000Z'));
    await def.run({ signal: new AbortController().signal });
    expect(await row('ancient')).toBeUndefined();
    await expect(svc.deliveryStatusRetentionSweep().run({ signal: new AbortController().signal })).resolves.toBeUndefined();
  });
});
