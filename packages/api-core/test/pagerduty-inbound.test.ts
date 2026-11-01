// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbound half of on-call: signature verification, the rota read, and the
 * two parsers.
 *
 * SIGNATURE VERIFICATION IS THE SECURITY BOUNDARY of this whole direction. The
 * route it guards writes a hash-chained audit row asserting that a human
 * acknowledged a page, and a latency metric backing the only claim of coverage
 * this system makes. If that can be forged by anyone who learns the URL, the
 * feature reports coverage it does not have — which is strictly worse than
 * having no on-call at all, because it transfers confidence without
 * transferring the rota.
 *
 * THE ROTA READ'S ONE INVARIANT: an unknown answer must never look like a
 * covered one. A failed call returns `known: false` and the caller publishes
 * nothing, because a 0 would read as "fully covered" — the exact reassurance a
 * failed request must not produce.
 */

import { createHmac } from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockSafeFetch = jest.fn<(...a: any[]) => any>();
const actualSsrf = jest.requireActual('../src/utils/ssrf.js') as typeof import('../src/utils/ssrf.js');
jest.unstable_mockModule('../src/utils/ssrf.js', () => ({
  __esModule: true,
  ...actualSsrf,
  safeFetch: mockSafeFetch,
}));

const {
  verifyPagerDutySignature, onCallInboundConfig, fetchRotaCoverage,
  parseOnCallWebhook, ackLatencySeconds,
} = await import('../src/services/pagerduty-inbound.js');

const SECRET = 'whsec-test';
const sign = (body: string, secret = SECRET) => `v1=${createHmac('sha256', secret).update(body).digest('hex')}`;

const ENV_KEYS = [
  'PAGERDUTY_WEBHOOK_SECRET', 'PAGERDUTY_API_TOKEN', 'PAGERDUTY_API_URL',
  'PAGERDUTY_ESCALATION_POLICY_IDS', 'ONCALL_SCHEDULE_GAP_LOOKAHEAD_HOURS',
];
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('verifyPagerDutySignature', () => {
  const body = '{"event":{"event_type":"incident.acknowledged"}}';

  it('accepts a correct signature over the RAW bytes', () => {
    expect(verifyPagerDutySignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyPagerDutySignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it('REFUSES everything when no secret is configured — fails closed', () => {
    // The important one. An unverified webhook that moves an audit record lets
    // anyone who learns the URL assert that a page was handled.
    expect(verifyPagerDutySignature(body, sign(body), '')).toBe(false);
  });

  it('refuses a missing header', () => {
    expect(verifyPagerDutySignature(body, undefined, SECRET)).toBe(false);
    expect(verifyPagerDutySignature(body, '', SECRET)).toBe(false);
  });

  it('refuses a signature computed with a different secret', () => {
    expect(verifyPagerDutySignature(body, sign(body, 'other'), SECRET)).toBe(false);
  });

  it('refuses a correct signature over DIFFERENT bytes', () => {
    // Which is what a re-serialized object is: `JSON.stringify(req.body)`
    // differs from the wire bytes in key order and whitespace. This is why the
    // route mounts `express.raw`.
    expect(verifyPagerDutySignature('{"event":{ }}', sign(body), SECRET)).toBe(false);
  });

  it('accepts ANY of several comma-separated signatures — that is how a secret rotates', () => {
    // Checking only the first breaks during PagerDuty's own rotation window.
    const header = `v1=${'0'.repeat(64)}, ${sign(body)}`;
    expect(verifyPagerDutySignature(body, header, SECRET)).toBe(true);
  });

  it('ignores versions it does not understand rather than treating them as a match', () => {
    expect(verifyPagerDutySignature(body, 'v2=whatever', SECRET)).toBe(false);
  });

  it('does not throw on a wrong-LENGTH signature', () => {
    // `timingSafeEqual` throws on a length mismatch and an attacker controls
    // this length, so an unguarded compare is a remote crash.
    expect(() => verifyPagerDutySignature(body, 'v1=abc', SECRET)).not.toThrow();
    expect(verifyPagerDutySignature(body, 'v1=abc', SECRET)).toBe(false);
  });
});

describe('onCallInboundConfig', () => {
  it('defaults both credentials empty — the rota check is opt-in on the STRONGER token', () => {
    const cfg = onCallInboundConfig();
    expect(cfg.webhookSecret).toBe('');
    expect(cfg.apiToken).toBe('');
    expect(cfg.lookaheadHours).toBe(48);
    expect(cfg.escalationPolicyIds).toEqual([]);
  });

  it('parses a comma-separated policy list, tolerating spaces and blanks', () => {
    process.env.PAGERDUTY_ESCALATION_POLICY_IDS = 'PABC, PDEF ,,';
    expect(onCallInboundConfig().escalationPolicyIds).toEqual(['PABC', 'PDEF']);
  });
});

describe('fetchRotaCoverage', () => {
  const cfg = (over: Partial<ReturnType<typeof onCallInboundConfig>> = {}) => ({
    webhookSecret: '',
    apiToken: 'TOKEN',
    apiUrl: 'https://api.pagerduty.com',
    lookaheadHours: 48,
    escalationPolicyIds: [],
    timeoutMs: 5000,
    ...over,
  });

  it('reports UNKNOWN with no API token, and never calls out', async () => {
    const r = await fetchRotaCoverage(cfg({ apiToken: '' }));
    expect(r).toEqual({ known: false, entries: 0, uncoveredSeconds: 0 });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('reports COVERED when entries come back', async () => {
    mockSafeFetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json: async () => ({ oncalls: [{}, {}] }) });
    expect(await fetchRotaCoverage(cfg())).toEqual({ known: true, entries: 2, uncoveredSeconds: 0 });
  });

  it('reports the WHOLE window uncovered when the rota is empty', async () => {
    mockSafeFetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json: async () => ({ oncalls: [] }) });
    const r = await fetchRotaCoverage(cfg({ lookaheadHours: 2 }));
    expect(r).toEqual({ known: true, entries: 0, uncoveredSeconds: 7200 });
  });

  it('reports UNKNOWN on a 401 — a revoked token is not an empty rota', async () => {
    // Conflating the two is how an expired token becomes either a false page or
    // silence. The caller publishes no gauge for an unknown.
    mockSafeFetch.mockResolvedValue({ ok: false, status: 401, redirected: false, json: async () => ({}) });
    expect(await fetchRotaCoverage(cfg())).toEqual({ known: false, entries: 0, uncoveredSeconds: 0 });
  });

  it('reports UNKNOWN on a redirect rather than following it', async () => {
    mockSafeFetch.mockResolvedValue({ ok: true, status: 302, redirected: true, json: async () => ({}) });
    expect((await fetchRotaCoverage(cfg())).known).toBe(false);
  });

  it('reports UNKNOWN and never throws when the transport fails', async () => {
    mockSafeFetch.mockRejectedValue(new Error('network'));
    expect(await fetchRotaCoverage(cfg())).toEqual({ known: false, entries: 0, uncoveredSeconds: 0 });
  });

  it('sends the REST auth scheme and the version-pinning Accept header', async () => {
    mockSafeFetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json: async () => ({ oncalls: [{}] }) });
    await fetchRotaCoverage(cfg());
    const [url, opts] = mockSafeFetch.mock.calls[0]!;
    expect(String(url)).toContain('/oncalls?');
    expect(String(url)).toContain('since=');
    expect(String(url)).toContain('until=');
    expect(opts.headers.Authorization).toBe('Token token=TOKEN');
    // Without the version pin the response shape is whatever their default is.
    expect(opts.headers.Accept).toContain('version=2');
  });

  it('passes each escalation policy as a repeated array parameter', async () => {
    mockSafeFetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json: async () => ({ oncalls: [{}] }) });
    await fetchRotaCoverage(cfg({ escalationPolicyIds: ['PABC', 'PDEF'] }));
    const url = String(mockSafeFetch.mock.calls[0]![0]);
    expect(url).toContain('escalation_policy_ids%5B%5D=PABC');
    expect(url).toContain('escalation_policy_ids%5B%5D=PDEF');
  });

  it('treats a malformed body as zero entries rather than throwing', async () => {
    mockSafeFetch.mockResolvedValue({ ok: true, status: 200, redirected: false, json: async () => ({}) });
    expect((await fetchRotaCoverage(cfg({ lookaheadHours: 1 })))).toEqual({ known: true, entries: 0, uncoveredSeconds: 3600 });
  });
});

describe('parseOnCallWebhook', () => {
  it('reduces a v3 body to the fields the handler uses', () => {
    const e = parseOnCallWebhook({
      event: {
        event_type: 'incident.acknowledged',
        occurred_at: '2026-11-01T03:20:00Z',
        agent: { id: 'PUSER1', summary: 'A Responder' },
        data: { id: 'PINC1', dedup_key: 'case:c1', created_at: '2026-11-01T03:14:00Z' },
      },
    });
    expect(e).toEqual({
      eventType: 'incident.acknowledged',
      incidentId: 'PINC1',
      dedupKey: 'case:c1',
      agentId: 'PUSER1',
      agentSummary: 'A Responder',
      createdAt: '2026-11-01T03:14:00Z',
      occurredAt: '2026-11-01T03:20:00Z',
    });
  });

  it('returns null for anything that is not a recognisable event', () => {
    expect(parseOnCallWebhook(null)).toBeNull();
    expect(parseOnCallWebhook({})).toBeNull();
    expect(parseOnCallWebhook({ event: {} })).toBeNull();
    expect(parseOnCallWebhook({ event: { event_type: 42 } })).toBeNull();
  });

  it('tolerates a body with no agent or data rather than throwing', () => {
    const e = parseOnCallWebhook({ event: { event_type: 'incident.resolved' } });
    expect(e?.eventType).toBe('incident.resolved');
    expect(e?.agentId).toBeUndefined();
  });
});

describe('ackLatencySeconds', () => {
  it('measures from the incident being raised to the event', () => {
    expect(ackLatencySeconds({
      eventType: 'incident.acknowledged',
      createdAt: '2026-11-01T03:14:00Z',
      occurredAt: '2026-11-01T03:20:00Z',
    })).toBe(360);
  });

  it('returns UNDEFINED rather than 0 when a timestamp is missing', () => {
    // A 0 lands in the first histogram bucket and reads as an instant
    // acknowledgement — the most flattering possible lie about response time.
    expect(ackLatencySeconds({ eventType: 'x', createdAt: '2026-11-01T03:14:00Z' })).toBeUndefined();
    expect(ackLatencySeconds({ eventType: 'x', occurredAt: '2026-11-01T03:14:00Z' })).toBeUndefined();
    expect(ackLatencySeconds({ eventType: 'x' })).toBeUndefined();
  });

  it('returns undefined for unparseable or inverted timestamps', () => {
    expect(ackLatencySeconds({ eventType: 'x', createdAt: 'nonsense', occurredAt: '2026-11-01T03:20:00Z' })).toBeUndefined();
    expect(ackLatencySeconds({ eventType: 'x', createdAt: '2026-11-01T03:20:00Z', occurredAt: '2026-11-01T03:14:00Z' })).toBeUndefined();
  });
});
