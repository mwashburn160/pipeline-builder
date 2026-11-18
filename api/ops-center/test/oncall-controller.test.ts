// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The on-call handlers end to end, with the REAL api-core pager client,
 * signature verifier, webhook parser and env-driven config — only the audit
 * emitter is stubbed (platform's ingest). Every outbound leg is made
 * network-free by configuration rather than by mocking: paging OFF is the
 * client's own skip, ON with no routing key is its own refusal, and the rota
 * read with no API token is its own "unknown".
 *
 *  - oncall-webhook: Alertmanager token auth, payload shape, the narrow page
 *    matcher (support critical / delivery meta), resolve vs trigger counting,
 *    truncation, and a failed dispatch still answering 200.
 *  - oncall-ack: fails CLOSED with no secret, refuses a bad signature, accepts
 *    any of several rotated v1= values, and audits ack / escalation (with the
 *    provider agent as actor) but not resolve / unacknowledged / unknown.
 *  - oncall-status: booleans, never the credential, and `wouldPage`.
 *  - oncall-test: always 200 with the outcome in the body, and always audited.
 */

import { createHmac } from 'node:crypto';
import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { makeRes } from './helpers/pglite-controller.js';

process.env.JWT_SECRET ||= 'oncall-controller-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.ALERT_WEBHOOK_INSTANCES = JSON.stringify([{ id: 'am-0', token: 'tok-0' }]);

const mockRecordAuditEvent = jest.fn();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  audit: jest.fn(),
  recordAuditEvent: (...a: unknown[]) => mockRecordAuditEvent(...a),
}));

const { oncallWebhook, oncallAckWebhook, oncallStatus, oncallTest } = await import('../src/controllers/oncall.js');

const ENV_KEYS = [
  'ONCALL_ENABLED', 'SUPPORT_ENABLED', 'PAGERDUTY_ROUTING_KEY', 'ONCALL_PROVIDER', 'ONCALL_EVENTS_URL',
  'PAGERDUTY_WEBHOOK_SECRET', 'PAGERDUTY_API_TOKEN', 'ONCALL_SCHEDULE_GAP_LOOKAHEAD_HOURS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  mockRecordAuditEvent.mockReset();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---------------------------------------------------------------------------
// oncall-webhook
// ---------------------------------------------------------------------------

const AUTH = { 'authorization': 'Bearer tok-0', 'x-alertmanager-instance': 'am-0' };
const alert = (labels: Record<string, string>, status = 'firing') => ({
  status, labels: { alertname: 'SupportSlaAtRisk', ...labels }, annotations: { summary: 's' }, fingerprint: 'fp1',
});
const SUPPORT_CRIT = { severity: 'critical', component: 'support', tenancy: 'platform' };

async function webhook(body: unknown, headers: Record<string, string> = AUTH) {
  const res = makeRes();
  await oncallWebhook({ headers, body, params: {}, query: {} } as never, res as never);
  return res;
}

describe('POST /observability/oncall-webhook', () => {
  it('401s a bad token and an unknown instance', async () => {
    expect((await webhook({ alerts: [] }, { 'authorization': 'Bearer nope', 'x-alertmanager-instance': 'am-0' })).statusCode).toBe(401);
    expect((await webhook({ alerts: [] }, { 'authorization': 'Bearer tok-0', 'x-alertmanager-instance': 'other' })).statusCode).toBe(401);
  });

  it('400s a payload without an alerts array', async () => {
    expect((await webhook({ status: 'firing' })).statusCode).toBe(400);
    expect((await webhook(undefined)).statusCode).toBe(400);
  });

  it('counts pages, resolves and ignored alerts (paging OFF: the client skips, still 200)', async () => {
    const res = await webhook({
      truncatedAlerts: 3,
      alerts: [
        alert(SUPPORT_CRIT),
        alert(SUPPORT_CRIT, 'resolved'),
        alert({ severity: 'warning', component: 'support' }),
        alert({ severity: 'critical', component: 'cluster' }),
        alert({ severity: 'info', delivery_meta: 'true', component: 'observability' }),
        { status: 'firing' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toEqual({ paged: 2, resolved: 1, ignored: 3 });
  });

  it('a dispatch the client refuses (ON with no routing key) is logged and the answer stays 200', async () => {
    process.env.ONCALL_ENABLED = 'true';
    const res = await webhook({ alerts: [alert(SUPPORT_CRIT)] });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toEqual({ paged: 1, resolved: 0, ignored: 0 });
  });
});

// ---------------------------------------------------------------------------
// oncall-ack
// ---------------------------------------------------------------------------

const SECRET = 'pd-webhook-secret';
const sign = (raw: string, secret = SECRET) => `v1=${createHmac('sha256', secret).update(raw).digest('hex')}`;

async function ack(body: unknown, signature?: string, opts: { asString?: boolean } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = signature ?? sign(raw);
  const res = makeRes();
  await oncallAckWebhook({
    headers: {},
    body: opts.asString ? raw : Buffer.from(raw, 'utf8'),
    header: (name: string) => (name.toLowerCase() === 'x-pagerduty-signature' ? sig : undefined),
  } as never, res as never);
  return res;
}

const pdEvent = (eventType: string, over: Record<string, unknown> = {}) => ({
  event: {
    event_type: eventType,
    occurred_at: '2026-11-01T03:20:00Z',
    agent: { id: 'PAGENT1', summary: 'Jo On-Call' },
    data: { id: 'PINC1', dedup_key: 'am:fp1', created_at: '2026-11-01T03:14:00Z' },
    ...over,
  },
});

describe('POST /observability/oncall-ack', () => {
  it('fails CLOSED with no PAGERDUTY_WEBHOOK_SECRET, even for a well-formed signature', async () => {
    const res = await ack(pdEvent('incident.acknowledged'));
    expect(res.statusCode).toBe(401);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('401s a signature made with the wrong secret, or a missing header', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    const raw = JSON.stringify(pdEvent('incident.acknowledged'));
    expect((await ack(raw, sign(raw, 'other-secret'))).statusCode).toBe(401);
    expect((await ack(raw, '')).statusCode).toBe(401);
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('accepts any of several comma-separated v1= values (provider secret rotation)', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    const raw = JSON.stringify(pdEvent('incident.acknowledged'));
    const res = await ack(raw, `v1=deadbeef, ${sign(raw)}`);
    expect(res.statusCode).toBe(200);
  });

  it('400s a correctly signed body that is not JSON', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    expect((await ack('{not json', undefined, { asString: true })).statusCode).toBe(400);
  });

  it('an unrecognised body is 200 { handled: false } and writes nothing', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    const res = await ack({ hello: 'world' });
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toEqual({ handled: false });
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('an acknowledgement is audited against the provider agent, with the ack latency', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    const res = await ack(pdEvent('incident.acknowledged'));
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toEqual({ handled: true });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.oncall.acknowledged',
      actorId: 'pagerduty:PAGENT1',
      targetType: 'oncall_page',
      targetId: 'am:fp1',
      details: { incidentId: 'PINC1', agent: 'Jo On-Call', ackSeconds: 360 },
    }));
  });

  it('an acknowledgement with no timestamps carries NO latency (never a flattering 0) and an unknown agent', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    await ack({ event: { event_type: 'incident.acknowledged', data: {} } });
    const [event] = mockRecordAuditEvent.mock.calls[0] as [{ actorId: string; targetId: string; details: Record<string, unknown> }];
    expect(event.actorId).toBe('pagerduty:unknown');
    expect(event.targetId).toBe('unknown');
    expect(event.details).not.toHaveProperty('ackSeconds');
  });

  it('an escalation is audited as such', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    await ack(pdEvent('incident.escalated', { data: { id: 'PINC2' } }));
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.oncall.escalated', targetId: 'PINC2',
    }));
  });

  it.each(['incident.resolved', 'incident.unacknowledged'])('%s is handled but NOT audited (our own act echoed back)', async (type) => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    const res = await ack(pdEvent(type));
    expect(res.body!.data).toEqual({ handled: true });
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('an event type outside the handled set is 200 { handled: false }', async () => {
    process.env.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    const res = await ack(pdEvent('incident.priority_updated'));
    expect(res.body!.data).toEqual({ handled: false });
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// oncall-status / oncall-test
// ---------------------------------------------------------------------------

async function getStatus() {
  const res = makeRes();
  await oncallStatus({ headers: {} } as never, res as never);
  return res;
}

describe('GET /observability/oncall-status', () => {
  it('reports an unconfigured deployment honestly: nothing configured, rota unknown, would not page', async () => {
    const res = await getStatus();
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toEqual({
      enabled: false,
      provider: 'pagerduty',
      routingKeyConfigured: false,
      endpointConfigured: true,
      ackWebhookConfigured: false,
      rotaReadable: false,
      rotaEntries: 0,
      lookaheadHours: 48,
      wouldPage: false,
    });
  });

  it('reports a fully configured pager as wouldPage, and never echoes a credential', async () => {
    process.env.ONCALL_ENABLED = 'true';
    process.env.PAGERDUTY_ROUTING_KEY = 'R0UTING-KEY-SECRET';
    process.env.PAGERDUTY_WEBHOOK_SECRET = 'WEBHOOK-SECRET';
    process.env.ONCALL_SCHEDULE_GAP_LOOKAHEAD_HOURS = '72';
    const res = await getStatus();
    expect(res.body!.data).toMatchObject({ enabled: true, routingKeyConfigured: true, ackWebhookConfigured: true, lookaheadHours: 72, wouldPage: true });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('R0UTING-KEY-SECRET');
    expect(wire).not.toContain('WEBHOOK-SECRET');
  });

  it('a custom provider with no events URL is NOT wouldPage, even with a key', async () => {
    process.env.ONCALL_ENABLED = 'true';
    process.env.PAGERDUTY_ROUTING_KEY = 'k';
    process.env.ONCALL_PROVIDER = 'custom';
    const res = await getStatus();
    expect(res.body!.data).toMatchObject({ provider: 'custom', endpointConfigured: false, wouldPage: false });
  });

  it('ONCALL_ENABLED without support stays OFF', async () => {
    process.env.ONCALL_ENABLED = 'true';
    process.env.SUPPORT_ENABLED = 'false';
    process.env.PAGERDUTY_ROUTING_KEY = 'k';
    expect((await getStatus()).body!.data).toMatchObject({ enabled: false, wouldPage: false });
  });
});

describe('POST /observability/oncall-test', () => {
  async function test(sub?: string) {
    const res = makeRes();
    await oncallTest({ headers: {}, user: sub ? { sub } : undefined } as never, res as never);
    return res;
  }

  it('paging OFF: 200 { sent: false, skipped: true }, audited as a success', async () => {
    const res = await test('user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toMatchObject({ sent: false, skipped: true });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.oncall.test', outcome: 'success', details: { sent: false, skipped: true },
    }));
  });

  it('ON but unconfigured: still 200, with the client\'s error, audited as a failure', async () => {
    process.env.ONCALL_ENABLED = 'true';
    const res = await test();
    expect(res.statusCode).toBe(200);
    expect(res.body!.data).toMatchObject({ sent: false, skipped: false, error: 'no routing key' });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });
});
