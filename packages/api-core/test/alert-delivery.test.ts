// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The alert-delivery posture: whether anyone would hear an alert at all.
 *
 * The property this file exists to defend is the SEPARATION of `enabled` from
 * `configured`, because collapsing them is the obvious simplification and it
 * produces a lying gauge either way round:
 *
 *  - keyed on the DECLARATION, `AlertDeliveryDisabled` fires on every deployment
 *    that left the flag at its (false) default while real Slack URLs sat in its
 *    Secret and delivery worked fine — a false alarm on a healthy system, which
 *    is the fastest way to teach people to ignore an alert;
 *  - keyed only on REALITY, enabled-with-no-credential becomes invisible, and
 *    that is the state where somebody asked for paging and is not getting it.
 *
 * Platform cannot inspect the Slack URLs — they are bearer credentials read per
 * notification from Alertmanager's Secret via `api_url_file` and never enter
 * this process — so `configured` has to be told to it at deploy time. That is
 * why there are two booleans for one channel and not one.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockSafeFetch = jest.fn<(...a: any[]) => any>();
const actualSsrf = jest.requireActual('../src/utils/ssrf.js') as typeof import('../src/utils/ssrf.js');
jest.unstable_mockModule('../src/utils/ssrf.js', () => ({
  __esModule: true,
  ...actualSsrf,
  safeFetch: mockSafeFetch,
}));

const gauges: Array<[string, Record<string, string>, number]> = [];
const actualEmitter = jest.requireActual('../src/utils/metric-emitter.js') as typeof import('../src/utils/metric-emitter.js');
jest.unstable_mockModule('../src/utils/metric-emitter.js', () => ({
  __esModule: true,
  ...actualEmitter,
  emitGauge: (n: string, l: Record<string, string>, v: number) => { gauges.push([n, l, v]); },
  emitCounter: jest.fn(),
}));

const {
  alertDeliveryConfig, slackAlertsConfig, canDeliverAnywhere, reportAlertDeliveryPosture,
  deadmanConfig, startDeadmanHeartbeat, stopDeadmanHeartbeat,
} = await import('../src/services/alert-delivery.js');

const ENV_KEYS = [
  'SLACK_ALERTS_ENABLED', 'SLACK_ALERTS_CONFIGURED', 'ONCALL_ENABLED',
  'PAGERDUTY_ROUTING_KEY', 'ONCALL_DEADMAN_URL', 'ONCALL_DEADMAN_INTERVAL_MS',
];

beforeEach(() => {
  gauges.length = 0;
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  mockSafeFetch.mockResolvedValue({ ok: true, status: 200, redirected: false });
});

afterEach(() => {
  stopDeadmanHeartbeat();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('slackAlertsConfig', () => {
  it('defaults BOTH flags off — a deployment states what it wants', () => {
    expect(slackAlertsConfig()).toEqual({ enabled: false, configured: false });
  });

  it('reads the derived flag independently of the declared one', () => {
    // The combination that matters: nobody declared Slack, and it works anyway
    // because real URLs are in the Secret. Keying the alert on `enabled` would
    // report this healthy deployment as having no alerting.
    process.env.SLACK_ALERTS_CONFIGURED = 'true';
    expect(slackAlertsConfig()).toEqual({ enabled: false, configured: true });
  });
});

describe('alertDeliveryConfig', () => {
  it('derives the pager\'s `configured` from the KEY, not from the knob', () => {
    process.env.ONCALL_ENABLED = 'true';
    const cfg = alertDeliveryConfig();
    // Enabled with no key — the half-configured state that is invisible if the
    // two booleans are collapsed into one.
    expect(cfg.pager).toEqual({ enabled: true, configured: false });

    process.env.PAGERDUTY_ROUTING_KEY = 'R0UTING';
    expect(alertDeliveryConfig().pager).toEqual({ enabled: true, configured: true });
  });
});

describe('canDeliverAnywhere', () => {
  const cfg = (slack: boolean, pagerOn: boolean, pagerKey: boolean) => ({
    slack: { enabled: false, configured: slack },
    pager: { enabled: pagerOn, configured: pagerKey },
  });

  it('is false only when nothing could actually deliver', () => {
    expect(canDeliverAnywhere(cfg(false, false, false))).toBe(false);
  });

  it('reads Slack REALITY and ignores the Slack declaration', () => {
    // Deliberate asymmetry: Alertmanager delivers to Slack whatever the knob
    // says, because the config is byte-identical across targets and cannot be
    // toggled. So `configured` alone decides for Slack.
    expect(canDeliverAnywhere(cfg(true, false, false))).toBe(true);
  });

  it('requires the pager to be BOTH enabled and keyed, unlike Slack', () => {
    // And here the knob IS honoured, because this process is the client: a
    // disabled client accepts and drops, so an enabled-but-keyless pager
    // delivers nothing and a keyed-but-disabled one delivers nothing either.
    expect(canDeliverAnywhere(cfg(false, true, false))).toBe(false);
    expect(canDeliverAnywhere(cfg(false, false, true))).toBe(false);
    expect(canDeliverAnywhere(cfg(false, true, true))).toBe(true);
  });
});

describe('reportAlertDeliveryPosture', () => {
  const find = (name: string, channel: string) => gauges.find(([n, l]) => n === name && l.channel === channel)?.[2];

  it('publishes all four gauges, so a dashboard answers the question without reading four YAML files', () => {
    reportAlertDeliveryPosture();
    expect(gauges).toHaveLength(4);
    expect(find('alert_delivery_enabled', 'slack')).toBe(0);
    expect(find('alert_delivery_enabled', 'pager')).toBe(0);
    expect(find('alert_delivery_configured', 'slack')).toBe(0);
    expect(find('alert_delivery_configured', 'pager')).toBe(0);
  });

  it('separates declaration from reality in the published series', () => {
    process.env.ONCALL_ENABLED = 'true';
    process.env.SLACK_ALERTS_CONFIGURED = 'true';
    reportAlertDeliveryPosture();
    expect(find('alert_delivery_enabled', 'pager')).toBe(1);
    expect(find('alert_delivery_configured', 'pager')).toBe(0);
    expect(find('alert_delivery_enabled', 'slack')).toBe(0);
    expect(find('alert_delivery_configured', 'slack')).toBe(1);
  });

  it('never throws on an incoherent posture — it is called once at boot', () => {
    process.env.ONCALL_ENABLED = 'true';
    expect(() => reportAlertDeliveryPosture()).not.toThrow();
  });
});

describe('the dead-man switch', () => {
  it('does not beat against nothing — an unconfigured switch must not claim coverage', () => {
    expect(deadmanConfig().url).toBe('');
    expect(startDeadmanHeartbeat()).toBe(false);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('beats IMMEDIATELY on start, not one interval later', async () => {
    // A heartbeat whose first beat is an interval away makes a deploy look like
    // an outage to whatever is watching for silence.
    process.env.ONCALL_DEADMAN_URL = 'https://deadman.example/beat';
    expect(startDeadmanHeartbeat()).toBe(true);
    await Promise.resolve();
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch.mock.calls[0]![0]).toBe('https://deadman.example/beat');
    expect(mockSafeFetch.mock.calls[0]![1].method).toBe('POST');
  });

  it('starts once — a second call is a no-op rather than a second timer', () => {
    process.env.ONCALL_DEADMAN_URL = 'https://deadman.example/beat';
    expect(startDeadmanHeartbeat()).toBe(true);
    expect(startDeadmanHeartbeat()).toBe(false);
  });

  it('can be restarted after a stop, so shutdown does not wedge it for the process', () => {
    process.env.ONCALL_DEADMAN_URL = 'https://deadman.example/beat';
    expect(startDeadmanHeartbeat()).toBe(true);
    stopDeadmanHeartbeat();
    expect(startDeadmanHeartbeat()).toBe(true);
  });
});
