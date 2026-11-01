// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pageDecision` — the Alertmanager leg's branch point.
 *
 * It is a pure function on purpose: this is where every decision about whether
 * to wake somebody lives, and the handler around it is plumbing. The properties
 * worth pinning are the ones a reader cannot get from the happy path:
 *
 *  - THE MATCHER IS RE-CHECKED, not trusted. The Alertmanager route matches the
 *    same `severity: critical` + `component: support` pair, so re-checking looks
 *    redundant — until a misrouted, replayed or hand-posted payload arrives at a
 *    URL that pages a human. A narrow matcher is also the only thing keeping the
 *    pager credible: let it fire for things nobody is contractually on the hook
 *    for and people learn to ignore it.
 *  - THE DEDUP KEY IS NAMESPACED. `am:` here, `case:` in the per-case sweep, so
 *    Alertmanager's grouping and the sweep's cannot fight over one incident.
 *  - RESOLVED STATUS BECOMES A RESOLVE, which is what closes the incident
 *    without a local state machine.
 *  - IDS AND LABELS ONLY. The on-call permission is system-org scoped and grants
 *    no tenant read access, so tenant content must not travel to a third party
 *    through this path.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

// The controller is imported for ONE pure export, but importing it loads
// platform's config chain, which refuses to boot without SECRET_ENCRYPTION_KEY
// — the shape in which a missing mock presents itself in these suites.
mockConfig();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const { pageDecision } = await import('../src/controllers/oncall.js');
type OnCallAlert = import('../src/controllers/oncall.js').OnCallAlert;

const supportCritical = (over: Partial<OnCallAlert> = {}): OnCallAlert => ({
  status: 'firing',
  labels: { severity: 'critical', component: 'support', alertname: 'SupportPremiumFirstResponseAtRisk', tenancy: 'platform' },
  annotations: { summary: 'p90 first response is drifting' },
  startsAt: '2026-11-01T03:14:00Z',
  fingerprint: 'abc123',
  ...over,
});

describe('pageDecision — what pages', () => {
  it('pages a support critical', () => {
    const e = pageDecision(supportCritical());
    expect(e).not.toBeNull();
    expect(e!.action).toBe('trigger');
    expect(e!.severity).toBe('critical');
    expect(e!.trigger).toBe('alertmanager');
  });

  it('pages a delivery meta-alert whatever its severity, because the circularity is the point', () => {
    // A Slack receiver with no URL cannot deliver "Slack has no URL". This
    // endpoint is the one place that accepts those unconditionally.
    const e = pageDecision({ status: 'firing', labels: { delivery_meta: 'true', severity: 'warning', component: 'observability', alertname: 'AlertDeliveryDisabled' } });
    expect(e).not.toBeNull();
    expect(e!.class).toBe('alert.delivery');
    // Labelled with the component it ACTUALLY carries, not forced to `support`:
    // a delivery meta-alert and a support breach must stay distinguishable in an
    // incident timeline.
    expect(e!.component).toBe('observability');
  });

  it('IGNORES a critical in another component — the matcher is narrow deliberately', () => {
    expect(pageDecision(supportCritical({ labels: { severity: 'critical', component: 'database' } }))).toBeNull();
  });

  it('IGNORES a support alert below critical', () => {
    expect(pageDecision(supportCritical({ labels: { severity: 'warning', component: 'support' } }))).toBeNull();
  });

  it('IGNORES an alert with no labels at all rather than throwing', () => {
    expect(pageDecision({})).toBeNull();
    expect(pageDecision({ labels: {} })).toBeNull();
  });

  it('does not treat a non-"true" delivery_meta value as a meta-alert', () => {
    expect(pageDecision({ labels: { delivery_meta: 'false', severity: 'info' } })).toBeNull();
    expect(pageDecision({ labels: { delivery_meta: '1', severity: 'info' } })).toBeNull();
  });
});

describe('pageDecision — the incident key', () => {
  it('keys on Alertmanager\'s own fingerprint, namespaced away from the sweep', () => {
    expect(pageDecision(supportCritical())!.dedupKey).toBe('am:abc123');
  });

  it('falls back to the alertname when no fingerprint arrives — coarser, still deduplicating', () => {
    // Without a fallback this would page once per evaluation.
    const e = pageDecision(supportCritical({ fingerprint: undefined }));
    expect(e!.dedupKey).toBe('am:SupportPremiumFirstResponseAtRisk');
  });

  it('never collides with the per-case sweep\'s `case:<id>` keys', () => {
    expect(pageDecision(supportCritical())!.dedupKey.startsWith('case:')).toBe(false);
  });
});

describe('pageDecision — resolution', () => {
  it('turns a resolved alert into a RESOLVE on the same key', () => {
    const firing = pageDecision(supportCritical())!;
    const resolved = pageDecision(supportCritical({ status: 'resolved' }))!;
    expect(resolved.action).toBe('resolve');
    // Same key, or the resolve closes nothing.
    expect(resolved.dedupKey).toBe(firing.dedupKey);
  });
});

describe('pageDecision — what leaves the building', () => {
  it('sends ids and labels only, never an annotation body', () => {
    const e = pageDecision(supportCritical({
      labels: { severity: 'critical', component: 'support', alertname: 'X', org_id: 'org-7' },
      annotations: { summary: 'the summary', description: 'a tenant name and a case subject' },
    }))!;
    expect(e.customDetails).toEqual({ alertname: 'X', startsAt: '2026-11-01T03:14:00Z', orgId: 'org-7' });
    expect(JSON.stringify(e.customDetails)).not.toContain('a tenant name');
  });

  it('omits orgId entirely when the alert carries none, rather than sending an empty one', () => {
    const e = pageDecision(supportCritical())!;
    expect(e.customDetails).not.toHaveProperty('orgId');
  });

  it('uses the summary as the page text, falling back to the alertname', () => {
    expect(pageDecision(supportCritical())!.summary).toBe('p90 first response is drifting');
    expect(pageDecision(supportCritical({ annotations: {} }))!.summary).toBe('SupportPremiumFirstResponseAtRisk');
  });

  it('reports the tenancy in `source`, so a platform alert is not read as a tenant\'s', () => {
    expect(pageDecision(supportCritical())!.source).toBe('pipeline-builder/platform');
    expect(pageDecision(supportCritical({ labels: { severity: 'critical', component: 'support', tenancy: 'org' } }))!.source).toBe('pipeline-builder/org');
  });
});

// The inbound leg's own branches — signature verification, the v3 parse and the
// ack-latency measurement — are covered in api-core's `pagerduty-inbound` suite
// against the REAL implementations. Re-testing them here would assert against
// this suite's api-core MOCK, which is a test of the mock.
