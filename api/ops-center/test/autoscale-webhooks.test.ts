// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The three Alertmanager-driven autoscaling webhooks (controllers/
 * pvc-autoexpand.ts, postgres-rung.ts, node-disk-autoexpand.ts): authenticated
 * by the per-instance relay bearer, acting only on the closed set of alerts
 * each owns, de-duplicated within a batch, and AUDITED (as the Alertmanager
 * instance, for the system org) only when infrastructure changed or the
 * attempt failed — refusals are counted, not recorded. The services that do
 * the work have their own suites; here they are stubbed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

type Auth = { ok: true; instance: { id: string } } | { ok: false; status: number; message: string; reason: string };
let auth: Auth = { ok: true, instance: { id: 'am-0' } };
const expandClaim = jest.fn<(...a: unknown[]) => Promise<any>>();
const scaleRung = jest.fn<(...a: unknown[]) => Promise<any>>();
const expandNodeDisk = jest.fn<(...a: unknown[]) => Promise<any>>();
const recordAuditEvent = jest.fn<(e: any) => void>();
const incCounter = jest.fn();

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ postgresRung: { namespace: 'pb' } }));
jest.unstable_mockModule('../src/helpers/alertmanager-auth.js', () => ({ authenticateAlertmanager: () => auth }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: (e: unknown) => recordAuditEvent(e), audit: jest.fn() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => incCounter(...a), setGauge: jest.fn(), observe: jest.fn() }));
jest.unstable_mockModule('../src/services/pvc-autoexpand.js', () => ({ expandClaim: (...a: unknown[]) => expandClaim(...a) }));
jest.unstable_mockModule('../src/services/postgres-rung.js', () => ({ scaleRung: (...a: unknown[]) => scaleRung(...a) }));
jest.unstable_mockModule('../src/services/node-disk-autoexpand.js', () => ({ expandNodeDisk: (...a: unknown[]) => expandNodeDisk(...a) }));

const { pvcAutoExpandWebhook } = await import('../src/controllers/pvc-autoexpand.js');
const { postgresRungWebhook } = await import('../src/controllers/postgres-rung.js');
const { nodeDiskAutoExpandWebhook } = await import('../src/controllers/node-disk-autoexpand.js');

function res() {
  const r: { statusCode?: number; body?: any; status: (n: number) => typeof r; json: (b: unknown) => typeof r; setHeader: () => void; headersSent: boolean } = {
    headersSent: false,
    status(n) { r.statusCode = n; return r; },
    json(b) { r.body = b; return r; },
    setHeader() { /* irrelevant */ },
  };
  return r;
}
const call = async (h: (req: any, res: any) => Promise<void>, body: unknown) => {
  const r = res();
  await h({ body, headers: {}, method: 'POST', path: '/x' }, r);
  return r;
};
const firing = (alertname: string, labels: Record<string, string> = {}) => ({ status: 'firing', labels: { alertname, ...labels } });

beforeEach(() => {
  auth = { ok: true, instance: { id: 'am-0' } };
  expandClaim.mockReset();
  scaleRung.mockReset();
  expandNodeDisk.mockReset();
  recordAuditEvent.mockReset();
  incCounter.mockReset();
});

describe.each([
  ['pvc-autoexpand', () => pvcAutoExpandWebhook],
  ['postgres-rung', () => postgresRungWebhook],
  ['node-disk-autoexpand', () => nodeDiskAutoExpandWebhook],
])('%s: authentication + payload', (_name, handler) => {
  it('answers the auth refusal (quietly when no instance is configured)', async () => {
    auth = { ok: false, status: 401, message: 'Unauthorized', reason: 'bad-token' };
    expect((await call(handler(), { alerts: [] })).statusCode).toBe(401);
    auth = { ok: false, status: 503, message: 'Alert relay not configured', reason: 'no-instances' };
    expect((await call(handler(), { alerts: [] })).statusCode).toBe(503);
  });

  it('400s a payload with no alerts array', async () => {
    expect((await call(handler(), {})).statusCode).toBe(400);
    expect((await call(handler(), undefined)).statusCode).toBe(400);
  });
});

describe('pvc-autoexpand', () => {
  it('expands each firing claim once, audits a change or a failure, and counts the rest as ignored', async () => {
    expandClaim
      .mockResolvedValueOnce({ namespace: 'pb', claim: 'data-a', outcome: 'expanded', fromGi: 10, toGi: 15 })
      .mockResolvedValueOnce({ namespace: 'pb', claim: 'data-b', outcome: 'error', detail: 'patch refused' })
      .mockResolvedValueOnce({ namespace: 'pb', claim: 'data-c', outcome: 'cooldown' });
    const r = await call(pvcAutoExpandWebhook, {
      alerts: [
        firing('PersistentVolumeFillingUp', { namespace: 'pb', persistentvolumeclaim: 'data-a' }),
        firing('PersistentVolumeCriticallyFull', { namespace: 'pb', persistentvolumeclaim: 'data-a' }),
        firing('PersistentVolumeFillingUp', { namespace: 'pb', persistentvolumeclaim: 'data-b' }),
        firing('PersistentVolumeFillingUp', { namespace: 'pb', persistentvolumeclaim: 'data-c' }),
        firing('PersistentVolumeFillingUp', { namespace: 'pb' }),
        { status: 'resolved', labels: { alertname: 'PersistentVolumeFillingUp' } },
        firing('SomethingElse'),
        {},
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toMatchObject({ considered: 3, ignored: 4 });
    expect(expandClaim).toHaveBeenCalledTimes(3);
    expect(incCounter).toHaveBeenCalledWith('pvc_autoexpand_ignored_total', {}, 4);
    expect(recordAuditEvent.mock.calls.map((c: any[]) => [c[0].targetId, c[0].outcome, c[0].actorId])).toEqual([
      ['pb/data-a', 'success', 'alertmanager:am-0'],
      ['pb/data-b', 'failure', 'alertmanager:am-0'],
    ]);
    expect(recordAuditEvent.mock.calls[0]![0].details).toEqual({ outcome: 'expanded', fromGi: 10, toGi: 15 });
  });
});

describe('postgres-rung', () => {
  it('takes ONE direction per workload (up wins), audits a scale or a failure', async () => {
    scaleRung
      .mockResolvedValueOnce({ workload: 'primary', direction: 'up', outcome: 'scaled', fromRung: 0, toRung: 1 })
      .mockResolvedValueOnce({ workload: 'replica', direction: 'down', outcome: 'error', detail: 'boom' });
    const r = await call(postgresRungWebhook, {
      alerts: [
        firing('PostgresPrimaryUnderutilised'),
        firing('PostgresPrimaryCpuSaturated'),
        firing('PostgresPrimaryUnderutilised'),
        firing('PostgresReadReplicaUnderutilised'),
        firing('PostgresReadReplicaUnderutilised'),
        firing('toString'),
        { status: 'resolved', labels: { alertname: 'PostgresPrimaryCpuSaturated' } },
      ],
    });
    expect(r.body.data).toMatchObject({ considered: 2, ignored: 2 });
    expect(scaleRung.mock.calls.map((c) => [c[1], c[2]])).toEqual([['primary', 'up'], ['replica', 'down']]);
    expect(scaleRung.mock.calls[0]![0]).toBe('pb');
    expect(recordAuditEvent.mock.calls.map((c: any[]) => [c[0].targetId, c[0].outcome])).toEqual([
      ['pb/primary', 'success'], ['pb/replica', 'failure'],
    ]);
  });

  it('records nothing for a refusal (cooldown / ceiling)', async () => {
    scaleRung.mockResolvedValue({ workload: 'primary', direction: 'up', outcome: 'at-ceiling' });
    await call(postgresRungWebhook, { alerts: [firing('PostgresPrimaryMemoryPressure')] });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe('node-disk-autoexpand', () => {
  it('ignores a batch with nothing actionable', async () => {
    const r = await call(nodeDiskAutoExpandWebhook, { alerts: [firing('Other'), { status: 'resolved', labels: { alertname: 'NodeDiskFillingUp' } }] });
    expect(r.body.data).toEqual({ considered: 0, ignored: 2 });
    expect(expandNodeDisk).not.toHaveBeenCalled();
    expect(incCounter).toHaveBeenCalledWith('node_disk_autoexpand_ignored_total', {}, 2);
  });

  it.each([
    [{ outcome: 'expanded', volumeId: 'vol-1', fromGi: 100, toGi: 150 }, 'success'],
    [{ outcome: 'fs-resize-failed', volumeId: 'vol-1', detail: 'ssm' }, 'failure'],
    [{ outcome: 'error' }, 'failure'],
  ])('audits %o as %s', async (result, outcome) => {
    expandNodeDisk.mockResolvedValue(result);
    const r = await call(nodeDiskAutoExpandWebhook, { alerts: [firing('NodeDiskCriticallyFull'), firing('Other')] });
    expect(r.body.data).toMatchObject({ considered: 1, ignored: 1, result });
    expect(recordAuditEvent.mock.calls[0]![0]).toMatchObject({ action: 'observability.node_disk.autoexpand', outcome });
  });

  it('records nothing when it did not act', async () => {
    expandNodeDisk.mockResolvedValue({ outcome: 'disabled' });
    await call(nodeDiskAutoExpandWebhook, { alerts: [firing('NodeDiskFillingUp')] });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
