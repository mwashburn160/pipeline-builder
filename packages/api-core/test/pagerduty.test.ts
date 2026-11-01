// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PagerDuty Events v2 client.
 *
 * Two properties carry most of the weight, and neither is obvious from reading
 * the happy path:
 *
 *  - CONFIGURED OFF IS A SKIP, NOT A FAILURE. `alertmanager.yml` is asserted
 *    byte-identical across deploy targets, so the paging route cannot be toggled
 *    per deployment — the knob works by this client accepting and dropping. If a
 *    disabled client returned `ok: false`, every deployment that does not page
 *    would collect `alertmanager_notifications_failed_total` and trip
 *    AlertmanagerNotificationsFailing, which is the failure mode the knob exists
 *    to avoid.
 *  - IT NEVER THROWS. Every caller is a webhook handler or a sweep, where an
 *    exception turns "could not page" into "crashed instead of paging".
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';

// Spread the real module and override only `safeFetch`: a hand-rolled namespace
// mock drops every export it forgets, and those link as `undefined` the moment
// production code imports one.
const mockSafeFetch = jest.fn<(...a: any[]) => any>();
const actualSsrf = jest.requireActual('../src/utils/ssrf.js') as typeof import('../src/utils/ssrf.js');
jest.unstable_mockModule('../src/utils/ssrf.js', () => ({
  __esModule: true,
  ...actualSsrf,
  safeFetch: mockSafeFetch,
}));

const { sendPagerDutyEvent, pagerDutyConfig, resolveEventsEndpoint, PAGERDUTY_EVENTS_URL } = await import('../src/services/pagerduty.js');

// The FULL config shape, deliberately. A mock missing one field is how a
// config value that cannot be read gets discovered during an incident — and
// `provider` was added to this interface after these tests were written, which
// is exactly when a partial fixture starts lying.
const ON = { enabled: true, routingKey: 'R0UTING', provider: 'pagerduty' as const, endpoint: 'https://events.pagerduty.com/v2/enqueue', timeoutMs: 5000 };
const body = () => JSON.parse(mockSafeFetch.mock.calls[0]![1].body as string);

describe('sendPagerDutyEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeFetch.mockResolvedValue({ ok: true, status: 202, redirected: false });
  });

  it('skips without calling out when paging is disabled', async () => {
    const r = await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, { ...ON, enabled: false });
    // ok:true so the Alertmanager leg sees a 200 and records no failure; skipped
    // so a caller can still tell "off" from "delivered".
    expect(r).toEqual({ ok: true, skipped: true });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('FAILS loudly when enabled with no routing key', async () => {
    // The half-configured state the knob exists to prevent: somebody asked for
    // paging and is not getting it, which must not look like a skip.
    const r = await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, { ...ON, routingKey: '' });
    expect(r.ok).toBe(false);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('sends a trigger with the API-required payload fields', async () => {
    await sendPagerDutyEvent({
      dedupKey: 'case:abc',
      action: 'trigger',
      summary: 'Premium case abc response due in 45m',
      severity: 'critical',
      source: 'pipeline-builder/eks',
      component: 'support',
      group: 'org-1',
      class: 'support.response_due',
      customDetails: { caseId: 'abc', orgId: 'org-1' },
    }, ON);
    const sent = body();
    expect(sent).toMatchObject({ routing_key: 'R0UTING', event_action: 'trigger', dedup_key: 'case:abc' });
    // summary/severity/source are required by the API; the rest are optional.
    expect(sent.payload).toMatchObject({
      summary: 'Premium case abc response due in 45m',
      severity: 'critical',
      source: 'pipeline-builder/eks',
      component: 'support',
      group: 'org-1',
      custom_details: { caseId: 'abc', orgId: 'org-1' },
    });
  });

  it('omits the payload entirely on resolve', async () => {
    // A resolve needs only the key and the action. Sending a payload it never
    // required is how a resolve gets rejected for a missing `summary`.
    await sendPagerDutyEvent({ dedupKey: 'case:abc', action: 'resolve' }, ON);
    const sent = body();
    expect(sent).toEqual({ routing_key: 'R0UTING', event_action: 'resolve', dedup_key: 'case:abc' });
    expect(sent.payload).toBeUndefined();
  });

  it('treats a redirect as a FAILED send, never a pivot', async () => {
    mockSafeFetch.mockResolvedValue({ ok: false, status: 302, redirected: true });
    const r = await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, ON);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redirect/i);
  });

  it('reports a rejection without throwing', async () => {
    mockSafeFetch.mockResolvedValue({ ok: false, status: 400, redirected: false });
    const r = await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, ON);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('never throws when the transport does', async () => {
    // The whole contract: an alerting path must not take the process down
    // because the pager was unreachable.
    mockSafeFetch.mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, ON);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ETIMEDOUT');
  });

  it('defaults a trigger\'s required fields rather than sending an invalid event', async () => {
    await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, ON);
    const p = body().payload;
    expect(typeof p.summary).toBe('string');
    expect(p.severity).toBe('critical');
    expect(typeof p.source).toBe('string');
  });
});

describe('resolveEventsEndpoint', () => {
  it('pins the known endpoint for pagerduty', () => {
    expect(resolveEventsEndpoint('pagerduty', '')).toBe(PAGERDUTY_EVENTS_URL);
  });

  it('returns EMPTY for custom with no URL — it does not fall back', () => {
    // Falling back is how a typo'd URL quietly sends this deployment's routing
    // key to a provider nobody chose, or pages nobody while reporting success.
    expect(resolveEventsEndpoint('custom', '')).toBe('');
  });

  it('lets an explicit URL win for either provider', () => {
    expect(resolveEventsEndpoint('custom', 'https://events.example/v2/enqueue')).toBe('https://events.example/v2/enqueue');
    expect(resolveEventsEndpoint('pagerduty', 'https://events.example/v2/enqueue')).toBe('https://events.example/v2/enqueue');
  });
});

describe('sendPagerDutyEvent with no endpoint', () => {
  it('refuses rather than reaching for PagerDuty with somebody else\'s key', async () => {
    const r = await sendPagerDutyEvent({ dedupKey: 'case:1', action: 'trigger' }, { ...ON, endpoint: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no events endpoint');
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

describe('pagerDutyConfig — the support prerequisite', () => {
  const KEYS = ['ONCALL_ENABLED', 'SUPPORT_ENABLED', 'ONCALL_PROVIDER', 'ONCALL_EVENTS_URL'];
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterAll(() => { for (const k of KEYS) delete process.env[k]; });

  it('is enabled when paging is asked for and support is on (the default)', () => {
    process.env.ONCALL_ENABLED = 'true';
    expect(pagerDutyConfig().enabled).toBe(true);
  });

  it('stays OFF when SUPPORT_ENABLED=false — there is no target to page about', () => {
    process.env.ONCALL_ENABLED = 'true';
    process.env.SUPPORT_ENABLED = 'false';
    expect(pagerDutyConfig().enabled).toBe(false);
  });

  it('does not complain about the prerequisite while paging is off', () => {
    // The precedent that matters: a validator once crashed billing at boot by
    // checking every bundle rather than every ACTIVE one. It is not a conflict
    // until somebody asks for the thing.
    process.env.SUPPORT_ENABLED = 'false';
    expect(pagerDutyConfig().enabled).toBe(false);
  });

  it('defaults the provider to pagerduty and resolves its endpoint', () => {
    expect(pagerDutyConfig().provider).toBe('pagerduty');
    expect(pagerDutyConfig().endpoint).toBe(PAGERDUTY_EVENTS_URL);
  });

  it('treats any unrecognised provider value as pagerduty rather than failing shut', () => {
    // A typo in a provider name must not silently disable paging; the endpoint
    // override is the escape hatch, and `custom` is the explicit opt-out.
    process.env.ONCALL_PROVIDER = 'opsgenie';
    expect(pagerDutyConfig().provider).toBe('pagerduty');
  });
});
