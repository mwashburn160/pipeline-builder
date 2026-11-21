// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Alert-destination CRUD, the test send and the Alertmanager relay through the
 * REAL controllers and services against a REAL Postgres (PGlite + the shipped
 * init script, as the application role under RLS + FORCE).
 *
 * Pins: per-channel target rules and the webhook SSRF refusal at create AND
 * update (including a channel switch re-validating the STORED target), target
 * masking on every read, soft delete → restore → purge with the quota
 * reserve/release around it, cross-org isolation, the sysadmin-only
 * cross-tenant list, the test send's 404 / 502 / 200 outcomes (the in-app
 * channel writes a real `messages` row), and the relay's token + per-instance
 * org allowlist.
 *
 * Stubbed: only the feature-quota reservation (platform + quota service) and
 * the audit emitter (platform's ingest).
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { featureQuotaMock } from './helpers/feature-quota-mock.js';
import { call, makeRes, type Caller } from './helpers/pglite-controller.js';

process.env.JWT_SECRET ||= 'alert-destinations-pglite-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ALERT_WEBHOOK_INSTANCES = JSON.stringify([
  { id: 'am-open', token: 'tok-open' },
  { id: 'am-scoped', token: 'tok-scoped', allowedOrgIds: ['org-dest-a'] },
]);

type Reservation = { exceeded: boolean; quota: { limit: number; used: number; remaining: number } };
const GRANTED: Reservation = { exceeded: false, quota: { limit: 10, used: 1, remaining: 9 } };
const mockReserve = jest.fn<(orgId: string, type: string) => Promise<Reservation>>();
const mockRelease = jest.fn();
const mockAudit = jest.fn();

jest.unstable_mockModule('../src/middleware/quota.js', () => featureQuotaMock({
  reserveFeatureQuota: (orgId: string, type: string) => mockReserve(orgId, type),
  releaseFeatureQuota: (...a: unknown[]) => mockRelease(...a),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  audit: (...a: unknown[]) => mockAudit(...a),
  recordAuditEvent: jest.fn(),
}));

const ctl = await import('../src/controllers/alert-destinations.js');

let tdb: TenantTestDb;
const owner = <T>(fn: (q: TenantTestDb['pglite']) => Promise<T>) => tdb.asOwner(fn);

const A: Caller = { orgId: 'org-dest-a', userId: 'user-a', email: 'a@example.com' };
const B: Caller = { orgId: 'org-dest-b', userId: 'user-b' };
const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
const NIL_ID = '00000000-0000-0000-0000-000000000000';

async function create(caller: Caller, body: Record<string, unknown>) {
  const res = await call(ctl.createAlertDestination, caller, { body });
  expect(res.statusCode).toBe(201);
  return res.body!.data.destination as { id: string; target: string; hasTarget: boolean; channel: string };
}

const storedTarget = async (id: string) => (await owner((q) => q.query<{ target: string; channel: string }>(
  'SELECT target, channel FROM org_alert_destinations WHERE id = $1', [id],
))).rows[0];

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM alert_destination_status; DELETE FROM org_alert_destinations; DELETE FROM messages;'));
  mockReserve.mockReset().mockResolvedValue(GRANTED);
  mockRelease.mockReset();
  mockAudit.mockReset();
});

describe('create', () => {
  it('stores a Slack destination, reserves quota, audits, and MASKS the target in the response', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK, minSeverity: 'critical' });
    expect(d.target).not.toBe(SLACK);
    // Origin only — none of the secret path (see maskTarget).
    expect(d.target).toBe('https://hooks.slack.com/••••');
    expect(d.hasTarget).toBe(true);
    expect(mockReserve).toHaveBeenCalledWith(A.orgId, 'alertDestinations');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.destination.create', expect.objectContaining({
      targetId: d.id, details: { channel: 'slack', label: 'ops', minSeverity: 'critical' },
    }));
    expect((await storedTarget(d.id))?.target).toBe(SLACK);
  });

  it('accepts in-app with no target and email with a valid address', async () => {
    const inApp = await create(A, { channel: 'in-app', label: 'inbox' });
    expect(inApp.hasTarget).toBe(false);
    await create(A, { channel: 'email', label: 'mail', target: 'admin@internal' });
  });

  it.each([
    [{ channel: 'slack', label: 'x', target: 'https://evil.example.com/hook' }, /hooks\.slack\.com/],
    [{ channel: 'webhook', label: 'x', target: 'http://plain.example.com/' }, /HTTPS/],
    [{ channel: 'email', label: 'x', target: 'not-an-address' }, /valid email/],
    [{ channel: 'slack', label: 'x', target: `https://hooks.slack.com/${'a'.repeat(3000)}` }, /exceeds/],
    [{ channel: 'email', label: 'x', target: `${'a'.repeat(3000)}@example.com` }, /exceeds|valid email/],
  ])('400s a bad channel/target combo %#', async (body, msg) => {
    const res = await call(ctl.createAlertDestination, A, { body });
    expect(res.statusCode).toBe(400);
    expect(res.body?.message).toMatch(msg);
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('400s (VALIDATION_ERROR) a target carrying the read-back mask, on every channel, and inserts nothing', async () => {
    for (const body of [
      { channel: 'slack', label: 'x', target: 'https://hooks.slack.com/••••' },
      { channel: 'webhook', label: 'x', target: 'https://example.com/••••' },
      { channel: 'email', label: 'x', target: '••••@example.com' },
      { channel: 'in-app', label: 'x', target: '••••' },
    ]) {
      const res = await call(ctl.createAlertDestination, A, { body });
      expect(res.statusCode).toBe(400);
      expect(res.body?.code).toBe('VALIDATION_ERROR');
    }
    expect(mockReserve).not.toHaveBeenCalled();
    expect((await owner((q) => q.query('SELECT 1 FROM org_alert_destinations'))).rows).toHaveLength(0);
  });

  it('400s a webhook target pointing at a private / metadata address (SSRF)', async () => {
    for (const target of ['https://169.254.169.254/latest', 'https://127.0.0.1/hook', 'https://10.0.0.5/x']) {
      const res = await call(ctl.createAlertDestination, A, { body: { channel: 'webhook', label: 'w', target } });
      expect(res.statusCode).toBe(400);
      expect(res.body?.message).toMatch(/Webhook target rejected/);
    }
  });

  it('400s a body that fails the schema (unknown channel)', async () => {
    const res = await call(ctl.createAlertDestination, A, { body: { channel: 'pager', label: 'x', target: 'y' } });
    expect(res.statusCode).toBe(400);
  });

  it('429s when the plan quota is exhausted and inserts nothing', async () => {
    mockReserve.mockResolvedValue({ exceeded: true, quota: { limit: 1, used: 1, remaining: 0 } });
    const res = await call(ctl.createAlertDestination, A, { body: { channel: 'in-app', label: 'inbox' } });
    expect(res.statusCode).toBe(429);
    expect((await owner((q) => q.query('SELECT 1 FROM org_alert_destinations'))).rows).toHaveLength(0);
  });
});

describe('list / isolation', () => {
  it('lists only the caller\'s org, masked, each with its last delivery status', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK });
    await create(B, { channel: 'in-app', label: 'theirs' });
    await owner((q) => q.query(
      'INSERT INTO alert_destination_status (destination_id, org_id, channel, last_attempt_at, last_ok, last_error_kind, consecutive_failures) VALUES ($1, $2, \'slack\', now(), false, \'rejected\', 3)',
      [d.id, A.orgId],
    ));

    const res = await call(ctl.listAlertDestinations, A);
    expect(res.statusCode).toBe(200);
    const list = res.body!.data.destinations as Array<{ id: string; target: string; delivery: { ok?: boolean; lastOk?: boolean } | null }>;
    expect(list.map((x) => x.id)).toEqual([d.id]);
    expect(list[0].target).not.toContain('hooks.slack.com/services');
    expect(list[0].delivery).not.toBeNull();
  });

  it('400s a caller with no organization', async () => {
    expect((await call(ctl.listAlertDestinations, { orgId: '', userId: 'u' })).statusCode).toBe(400);
    expect((await call(ctl.listDeletedAlertDestinations, { orgId: '', userId: 'u' })).statusCode).toBe(400);
  });

  it('the cross-tenant list is sysadmin-only and spans every org (still masked)', async () => {
    await create(A, { channel: 'slack', label: 'a', target: SLACK });
    await create(B, { channel: 'in-app', label: 'b' });

    expect((await call(ctl.listAllAlertDestinations, A)).statusCode).toBe(403);

    const res = await call(ctl.listAllAlertDestinations, { orgId: 'sys', userId: 'root', isSuperAdmin: true });
    expect(res.statusCode).toBe(200);
    const list = res.body!.data.destinations as Array<{ orgId: string; target: string }>;
    expect(list.map((x) => x.orgId).sort()).toEqual([A.orgId, B.orgId]);
    expect(list.every((x) => !x.target.includes('/services/'))).toBe(true);
  });
});

describe('update', () => {
  it('patches fields; an empty target keeps the stored secret', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK });
    const res = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { label: 'renamed', target: '', enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data.destination).toMatchObject({ label: 'renamed', enabled: false });
    expect((await storedTarget(d.id))?.target).toBe(SLACK);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.destination.update', expect.objectContaining({ targetId: d.id }));
  });

  it('a target sent back as the masked read-back keeps the stored secret (round-trip of a GET)', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK });
    const res = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { label: 'renamed', target: d.target } });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data.destination).toMatchObject({ label: 'renamed', target: 'https://hooks.slack.com/••••' });
    expect((await storedTarget(d.id))?.target).toBe(SLACK);
  });

  it('a masked target with a channel switch re-validates the STORED target, never stores the mask', async () => {
    const d = await create(A, { channel: 'email', label: 'mail', target: 'ops@example.com' });
    const res = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { channel: 'slack', target: 'https://hooks.slack.com/••••' } });
    expect(res.statusCode).toBe(400);
    expect(res.body?.message).toMatch(/hooks\.slack\.com/);
    expect(await storedTarget(d.id)).toMatchObject({ target: 'ops@example.com', channel: 'email' });
  });

  it('validates a new target against the STORED channel when no channel is sent', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK });
    const bad = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { target: 'https://evil.example.com/' } });
    expect(bad.statusCode).toBe(400);
    const good = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { target: `${SLACK}x` } });
    expect(good.statusCode).toBe(200);
    expect((await storedTarget(d.id))?.target).toBe(`${SLACK}x`);
  });

  it('validates a new target against a NEW channel, including the SSRF check', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK });
    const res = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { channel: 'webhook', target: 'https://127.0.0.1/x' } });
    expect(res.statusCode).toBe(400);
    expect(res.body?.message).toMatch(/Webhook target rejected/);
    expect((await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { channel: 'email', target: 'nope' } })).statusCode).toBe(400);
  });

  it('a channel switch with no target re-validates the STORED target (no relabel bypass)', async () => {
    const d = await create(A, { channel: 'email', label: 'mail', target: 'ops@example.com' });
    const res = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { channel: 'slack' } });
    expect(res.statusCode).toBe(400);
    expect(res.body?.message).toMatch(/hooks\.slack\.com/);

    // A stored internal webhook URL (pre-dating the SSRF check) can't be kept by relabeling.
    await owner((q) => q.query('UPDATE org_alert_destinations SET channel = \'slack\', target = \'https://127.0.0.1/x\' WHERE id = $1', [d.id]));
    const ssrf = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { channel: 'webhook' } });
    expect(ssrf.statusCode).toBe(400);
    expect(ssrf.body?.message).toMatch(/Webhook target rejected/);

    const inApp = await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { channel: 'in-app' } });
    expect(inApp.statusCode).toBe(200);
  });

  it('404s an unknown or another org\'s destination on every update branch', async () => {
    const theirs = await create(B, { channel: 'slack', label: 'b', target: SLACK });
    for (const body of [{ target: `${SLACK}y` }, { channel: 'in-app' }, { label: 'pwned' }]) {
      expect((await call(ctl.updateAlertDestination, A, { params: { id: theirs.id }, body })).statusCode).toBe(404);
    }
    expect((await call(ctl.updateAlertDestination, A, { params: { id: NIL_ID }, body: { label: 'x' } })).statusCode).toBe(404);
    expect((await storedTarget(theirs.id))?.target).toBe(SLACK);
  });

  it('400s a body that fails the schema', async () => {
    const d = await create(A, { channel: 'in-app', label: 'x' });
    expect((await call(ctl.updateAlertDestination, A, { params: { id: d.id }, body: { minSeverity: 'apocalyptic' } })).statusCode).toBe(400);
  });
});

describe('delete → restore → purge lifecycle', () => {
  it('soft-deletes (release), lists the masked tombstone, restores (reserve), then purges', async () => {
    const d = await create(A, { channel: 'slack', label: 'ops', target: SLACK });

    const del = await call(ctl.deleteAlertDestination, A, { params: { id: d.id } });
    expect(del.statusCode).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith(A.orgId, 'alertDestinations', expect.any(Function), null);
    expect((await call(ctl.listAlertDestinations, A)).body!.data.destinations).toEqual([]);
    expect((await call(ctl.deleteAlertDestination, A, { params: { id: d.id } })).statusCode).toBe(404);

    const deleted = await call(ctl.listDeletedAlertDestinations, A);
    expect(deleted.body!.data.destinations).toHaveLength(1);
    expect(deleted.body!.data.destinations[0].target).not.toBe(SLACK);
    expect((await call(ctl.listDeletedAlertDestinations, B)).body!.data.destinations).toEqual([]);

    // Live → purge refused.
    mockReserve.mockClear();
    expect((await call(ctl.restoreAlertDestination, A, { params: { id: d.id } })).statusCode).toBe(200);
    expect(mockReserve).toHaveBeenCalledWith(A.orgId, 'alertDestinations');
    expect((await call(ctl.purgeAlertDestination, A, { params: { id: d.id } })).statusCode).toBe(404);

    await call(ctl.deleteAlertDestination, A, { params: { id: d.id } });
    const purged = await call(ctl.purgeAlertDestination, A, { params: { id: d.id } });
    expect(purged.statusCode).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.destination.purge', expect.objectContaining({
      details: { channel: 'slack', label: 'ops' },
    }));
    // The purge audit record never carries the secret target.
    const purgeCall = mockAudit.mock.calls.find((c) => c[1] === 'alert.destination.purge');
    expect(JSON.stringify(purgeCall?.[2])).not.toContain('hooks.slack.com');
    expect((await owner((q) => q.query('SELECT 1 FROM org_alert_destinations WHERE id = $1', [d.id]))).rows).toHaveLength(0);
  });

  it('restore of an unknown id is a 404 that gives the reserved slot back', async () => {
    const res = await call(ctl.restoreAlertDestination, A, { params: { id: NIL_ID } });
    expect(res.statusCode).toBe(404);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('another org can neither delete, restore nor purge my destination', async () => {
    const d = await create(A, { channel: 'in-app', label: 'mine' });
    expect((await call(ctl.deleteAlertDestination, B, { params: { id: d.id } })).statusCode).toBe(404);
    await call(ctl.deleteAlertDestination, A, { params: { id: d.id } });
    expect((await call(ctl.restoreAlertDestination, B, { params: { id: d.id } })).statusCode).toBe(404);
    expect((await call(ctl.purgeAlertDestination, B, { params: { id: d.id } })).statusCode).toBe(404);
    expect((await owner((q) => q.query('SELECT 1 FROM org_alert_destinations WHERE id = $1', [d.id]))).rows).toHaveLength(1);
  });

  it('401s every mutation without an authenticated user', async () => {
    for (const h of [ctl.createAlertDestination, ctl.updateAlertDestination, ctl.deleteAlertDestination,
      ctl.restoreAlertDestination, ctl.purgeAlertDestination, ctl.testAlertDestination]) {
      const res = makeRes();
      await h({ headers: {}, params: { id: 'x' }, body: {}, query: {} } as never, res as never);
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('test send', () => {
  it('404s an unknown / another org\'s destination', async () => {
    const theirs = await create(B, { channel: 'in-app', label: 'b' });
    expect((await call(ctl.testAlertDestination, A, { params: { id: theirs.id } })).statusCode).toBe(404);
    expect((await call(ctl.testAlertDestination, A, { params: { id: NIL_ID } })).statusCode).toBe(404);
  });

  it('a delivery failure is a GENERIC 502 (the specific reason only in the audit record)', async () => {
    const d = await create(A, { channel: 'in-app', label: 'x' });
    // Make the in-app channel's inbox write fail inside its transaction.
    await owner((q) => q.exec(`
      CREATE OR REPLACE FUNCTION test_reject_message() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'inbox write refused'; END $$;
      CREATE TRIGGER test_reject_message BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION test_reject_message();
    `));
    let res;
    try {
      res = await call(ctl.testAlertDestination, A, { params: { id: d.id } });
    } finally {
      await owner((q) => q.exec('DROP TRIGGER test_reject_message ON messages; DROP FUNCTION test_reject_message();'));
    }
    expect(res.statusCode).toBe(502);
    expect(res.body?.message).toBe('Test notification failed to send');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'alert.destination.test', expect.objectContaining({
      outcome: 'failure',
      details: expect.objectContaining({ delivered: false, error: expect.stringContaining('messages') }),
    }));
  });

  it('an in-app test send writes the org\'s inbox row and answers 200', async () => {
    const d = await create(A, { channel: 'in-app', label: 'inbox' });
    const res = await call(ctl.testAlertDestination, A, { params: { id: d.id } });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toEqual({ delivered: true });
    const { rows } = await owner((q) => q.query<{ recipient_org_id: string; subject: string }>('SELECT recipient_org_id, subject FROM messages'));
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_org_id).toBe(A.orgId);
  });
});

describe('Alertmanager relay', () => {
  const relay = async (headers: Record<string, string>, body: unknown) => {
    const res = makeRes();
    await ctl.alertWebhook({ headers, body, params: {}, query: {} } as never, res as never);
    return res;
  };
  const alert = (orgId?: string, severity = 'critical') => ({
    status: 'firing',
    labels: { alertname: 'HighErrors', severity, tenancy: 'org', ...(orgId ? { org_id: orgId } : {}) },
    annotations: { summary: 'errors are high' },
    startsAt: new Date().toISOString(),
  });

  it('401s a missing instance header, an unknown instance and a bad token', async () => {
    expect((await relay({ authorization: 'Bearer tok-open' }, { alerts: [] })).statusCode).toBe(401);
    expect((await relay({ 'authorization': 'Bearer tok-open', 'x-alertmanager-instance': 'who' }, { alerts: [] })).statusCode).toBe(401);
    expect((await relay({ 'authorization': 'Bearer nope', 'x-alertmanager-instance': 'am-open' }, { alerts: [] })).statusCode).toBe(401);
  });

  it('400s a payload without an alerts array', async () => {
    expect((await relay({ 'authorization': 'Bearer tok-open', 'x-alertmanager-instance': 'am-open' }, { nope: 1 })).statusCode).toBe(400);
  });

  it('403s an alert outside the instance\'s org allowlist (or with no org_id)', async () => {
    const h = { 'authorization': 'Bearer tok-scoped', 'x-alertmanager-instance': 'am-scoped' };
    expect((await relay(h, { alerts: [alert(B.orgId)] })).statusCode).toBe(403);
    expect((await relay(h, { alerts: [alert()] })).statusCode).toBe(403);
  });

  it('fans an allowed alert out to the org\'s destinations (real in-app delivery) and counts outcomes', async () => {
    await create(A, { channel: 'in-app', label: 'inbox', minSeverity: 'warning' });
    const res = await relay(
      { 'authorization': 'Bearer tok-scoped', 'x-alertmanager-instance': 'am-scoped' },
      { alerts: [alert(A.orgId)] },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toMatchObject({ delivered: 1, failed: 0 });
    const { rows } = await owner((q) => q.query<{ recipient_org_id: string }>('SELECT recipient_org_id FROM messages'));
    expect(rows.map((r) => r.recipient_org_id)).toEqual([A.orgId]);
  });

  it('an open instance skips alerts with no org_id or no destinations', async () => {
    const res = await relay(
      { 'authorization': 'Bearer tok-open', 'x-alertmanager-instance': 'am-open' },
      { alerts: [alert(), alert(B.orgId)] },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toMatchObject({ delivered: 0, skipped: 2 });
  });
});
