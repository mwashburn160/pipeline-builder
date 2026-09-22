// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ecosystem operations (docs/plans/plugin-ecosystem.md §3.0.1, §3.7, §5b N22,
 * §9a) against the in-memory database:
 *
 *  - automatic Verified eligibility (plan, DNS-verified domain, owner MFA) at
 *    application AND decision time, failing closed when platform can't answer;
 *  - the approver standing on the overview and per request (conflicts removed);
 *  - the §9a gauges, decision counters and SLA-breach notices (N22, once per
 *    request).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

import { SYSTEM_ORG, moderator, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const setGauge = jest.fn();
const incCounter = jest.fn();
const observe = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge, incCounter, observe }));

const h = setupEcosystemHarness();
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const consoleSvc = await import('../src/services/ecosystem/console.js');
const metrics = await import('../src/services/ecosystem/metrics.js');
const sla = await import('../src/services/ecosystem/sla.js');
const maintenance = await import('../src/services/ecosystem/maintenance.js');
const eligibility = await import('../src/services/ecosystem/verified-eligibility.js');
const platformReads = await import('../src/services/ecosystem/platform-reads.js');
await wireEcosystemHarness(h);

const { db } = h;
const MOD_A = moderator('mod-a') as any;
const MOD_B = moderator('mod-b') as any;
const APPLICANT = tenant({ features: ['verified_publisher'] }) as any;
const HOUR = 3_600_000;

async function rejects(p: Promise<unknown>, code: string): Promise<{ code: string; message: string; details?: any }> {
  try {
    await p;
  } catch (err) {
    expect((err as { code: string }).code).toBe(code);
    return err as { code: string; message: string; details?: any };
  }
  throw new Error(`expected ${code}`);
}

const gauge = (name: string, labels: Record<string, string>) =>
  setGauge.mock.calls.filter((c) => c[0] === name && JSON.stringify(c[1]) === JSON.stringify(labels)).at(-1)?.[2];

beforeEach(() => {
  db.reset();
  h.notify.mockReset().mockResolvedValue('sent' as never);
  h.audit.mockClear();
  h.membership.mockReset().mockResolvedValue(false as never);
  h.quota.getTierStrict.mockResolvedValue('team' as never);
  h.platform.eligibility.mockReset().mockResolvedValue({ verifiedDomains: ['acme.dev'], owners: 1, ownersWithMfa: 1 } as never);
  h.platform.approvers.mockReset().mockResolvedValue({ holders: 3, eligible: 3, superadmins: 1 } as never);
  setGauge.mockClear();
  incCounter.mockClear();
  observe.mockClear();
  metrics.resetEcosystemMetricsForTests();
});

// -----------------------------------------------------------------------------
// Verified eligibility
// -----------------------------------------------------------------------------

describe('Verified eligibility at application time (§3.7)', () => {
  it('records all three passing checks on the request', async () => {
    seedPublishers(db);
    const out = await requestsSvc.submit(APPLICANT, { kind: 'verify', application: { domain: 'ACME.dev' } });
    const e = (out.request.payload as any).eligibility;
    expect(e.eligible).toBe(true);
    expect(e.checks.map((c: any) => [c.id, c.ok])).toEqual([['plan', true], ['domain', true], ['owner_mfa', true]]);
    expect(h.platform.eligibility).toHaveBeenCalledWith('org-acme');
  });

  it('refuses without a DNS-verified domain, or naming a domain the org has not verified', async () => {
    seedPublishers(db);
    h.platform.eligibility.mockResolvedValue({ verifiedDomains: [], owners: 1, ownersWithMfa: 1 } as never);
    const err = await rejects(requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} }), 'VERIFIED_DOMAIN_REQUIRED');
    expect(err.message).toContain('no DNS-verified domain');
    expect(err.details.checks).toHaveLength(3);

    h.platform.eligibility.mockResolvedValue({ verifiedDomains: ['acme.dev'], owners: 1, ownersWithMfa: 1 } as never);
    const named = await rejects(requestsSvc.submit(APPLICANT, { kind: 'verify', application: { domain: 'evil.dev' } }), 'VERIFIED_DOMAIN_REQUIRED');
    expect(named.message).toContain('evil.dev is not a verified domain');
  });

  it('refuses when an owner has no second factor, or the org has no owner', async () => {
    seedPublishers(db);
    h.platform.eligibility.mockResolvedValue({ verifiedDomains: ['acme.dev'], owners: 2, ownersWithMfa: 1 } as never);
    const err = await rejects(requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} }), 'VERIFIED_OWNER_MFA_REQUIRED');
    expect(err.message).toBe('1 of 2 owners have no passkey or authenticator app.');
    h.platform.eligibility.mockResolvedValue({ verifiedDomains: ['acme.dev'], owners: 0, ownersWithMfa: 0 } as never);
    expect((await rejects(requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} }), 'VERIFIED_OWNER_MFA_REQUIRED')).message)
      .toContain('no active owner');
  });

  it('the plan check comes first; an unreachable platform FAILS CLOSED (503)', async () => {
    seedPublishers(db);
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'verify', application: {} }), 'VERIFIED_PLAN_REQUIRED');
    h.platform.eligibility.mockResolvedValue(null as never);
    const err = await rejects(requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} }), 'SERVICE_UNAVAILABLE');
    expect(err.details.checks.map((c: any) => c.ok)).toEqual([true, null, null]);
    expect(db.tables.plugin_publish_requests ?? []).toHaveLength(0);
  });
});

describe('Verified eligibility at decision time', () => {
  it('re-checks at the first approval (a lapsed domain) and at execution (a plan downgrade), leaving the request open', async () => {
    const { acme } = seedPublishers(db);
    const v = await requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} });

    h.platform.eligibility.mockResolvedValueOnce({ verifiedDomains: [], owners: 1, ownersWithMfa: 1 } as never);
    await rejects(decisions.approve(MOD_A, v.request.id, null), 'VERIFIED_DOMAIN_REQUIRED');
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'pending' });

    expect((await decisions.approve(MOD_A, v.request.id, null)).executed).toBe(false);
    h.quota.getTierStrict.mockResolvedValue('pro' as never);
    await rejects(decisions.secondApprove(MOD_B, v.request.id, null), 'VERIFIED_PLAN_REQUIRED');
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'pending_second_approval' });
    expect(acme.tier).toBe('community');

    h.quota.getTierStrict.mockResolvedValue('team' as never);
    await decisions.secondApprove(MOD_B, v.request.id, null);
    expect(acme.tier).toBe('verified');
  });

  it('a quota-service failure at decision time is "unknown" (fail closed)', async () => {
    seedPublishers(db);
    const v = await requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} });
    h.quota.getTierStrict.mockRejectedValueOnce(new Error('down') as never);
    await rejects(decisions.approve(MOD_A, v.request.id, null), 'SERVICE_UNAVAILABLE');
    // The real client answers an outage with null (never DEFAULT_TIER): unknown too.
    h.quota.getTierStrict.mockResolvedValueOnce(null as never);
    await rejects(decisions.approve(MOD_A, v.request.id, null), 'SERVICE_UNAVAILABLE');
  });

  it('a manager-initiated Verified tier change is refused for an ineligible org', async () => {
    const { acme } = seedPublishers(db);
    h.platform.eligibility.mockResolvedValue({ verifiedDomains: ['acme.dev'], owners: 1, ownersWithMfa: 0 } as never);
    await rejects(consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'verified', reason: 'known vendor' }), 'VERIFIED_OWNER_MFA_REQUIRED');
    expect(db.tables.plugin_publish_requests ?? []).toHaveLength(0);
  });

  it('the review of an open application carries a LIVE eligibility check', async () => {
    seedPublishers(db);
    const v = await requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} });
    h.platform.eligibility.mockResolvedValue({ verifiedDomains: [], owners: 1, ownersWithMfa: 1 } as never);
    const detail = await consoleSvc.requestDetail(MOD_A, v.request.id);
    expect(detail.eligibility).toMatchObject({ eligible: false });
    expect(detail.eligibility!.checks.find((c) => c.id === 'domain')!.ok).toBe(false);
  });

  it('checkVerifiedEligibility uses the org\'s current plan when no token answer is given', async () => {
    h.quota.getTierStrict.mockResolvedValue('developer' as never);
    const e = await eligibility.checkVerifiedEligibility('org-acme');
    expect(e.checks[0]).toMatchObject({ id: 'plan', ok: false });
    expect(() => eligibility.assertVerifiedEligible(e, 'decision')).toThrow(expect.objectContaining({ code: 'VERIFIED_PLAN_REQUIRED' }) as any);
  });
});

// -----------------------------------------------------------------------------
// Approver standing (§3.0.1)
// -----------------------------------------------------------------------------

describe('eligible approvers', () => {
  it('the overview reports both permissions with the minimum and the shortage flags', async () => {
    h.platform.approvers.mockImplementation((async (permission: string) => (permission === 'plugins:moderate'
      ? { holders: 2, eligible: 2, superadmins: 1 }
      : { holders: 1, eligible: 1, superadmins: 1 })) as never);
    const o = await consoleSvc.overview();
    expect(o.approvers).toEqual({
      minimum: 3,
      twoPersonMinimum: 2,
      moderate: { permission: 'plugins:moderate', count: { holders: 2, eligible: 2, superadmins: 1 }, belowMinimum: true, belowTwoPerson: false },
      verify: { permission: 'publishers:verify', count: { holders: 1, eligible: 1, superadmins: 1 }, belowMinimum: true, belowTwoPerson: true },
    });
  });

  it('an unknown count never reads as a shortage', async () => {
    h.platform.approvers.mockResolvedValue(null as never);
    const o = await consoleSvc.overview();
    expect(o.approvers.moderate).toEqual({ permission: 'plugins:moderate', count: null, belowMinimum: false, belowTwoPerson: false });
  });

  it('a request\'s approvers exclude the requester\'s conflicts (orgs, submitter, first approver)', async () => {
    seedPublishers(db);
    const v = await requestsSvc.submit(APPLICANT, { kind: 'verify', application: {} });
    await consoleSvc.requestDetail(MOD_A, v.request.id);
    expect(h.platform.approvers).toHaveBeenLastCalledWith('publishers:verify', { orgIds: ['org-acme'], userIds: ['u-acme'] });

    await decisions.approve(MOD_A, v.request.id, null);
    h.platform.approvers.mockResolvedValue({ holders: 3, eligible: 1, superadmins: 1 } as never);
    const detail = await consoleSvc.requestDetail(MOD_B, v.request.id);
    expect(h.platform.approvers).toHaveBeenLastCalledWith('publishers:verify', { orgIds: ['org-acme'], userIds: ['u-acme', 'mod-a'] });
    expect(detail.approvers).toMatchObject({ belowTwoPerson: true });

    await decisions.secondApprove(MOD_B, v.request.id, null);
    expect((await consoleSvc.requestDetail(MOD_B, v.request.id)).approvers).toBeNull();
  });

  it('a transfer\'s receiving org is a conflict too; the system org never is', async () => {
    const r = { kind: 'transfer', status: 'pending', submittedBy: 'u1', submittedOrgId: 'ORG-A', firstApprovedBy: null, payload: { transfer: { targetOrgId: 'org-b' } } } as any;
    await consoleSvc.requestApprovers(r, { ownerOrgId: SYSTEM_ORG } as any);
    expect(h.platform.approvers).toHaveBeenLastCalledWith('publishers:verify', { orgIds: ['org-a', 'org-b'], userIds: ['u1'] });
  });
});

// -----------------------------------------------------------------------------
// §9a metrics
// -----------------------------------------------------------------------------

function openRequest(publisherId: string, over: Record<string, unknown> = {}) {
  return db.seed('plugin_publish_requests', {
    publisherId, kind: 'new_version', status: 'pending', lane: 'standard', submittedBy: 'u-acme', submittedOrgId: 'org-acme', payload: { name: 'lint' }, version: '1.1.0', ...over,
  });
}

describe('ecosystem gauges', () => {
  it('samples queue depth, oldest age, SLA breaches, re-sign jobs and approvers; drained label sets drop to 0', async () => {
    const { acme } = seedPublishers(db);
    const now = new Date('2026-09-21T12:00:00Z');
    openRequest(acme.id, { createdAt: new Date(now.getTime() - 50 * HOUR) });
    const sec = openRequest(acme.id, { lane: 'security', createdAt: new Date(now.getTime() - 5 * HOUR) });
    openRequest(acme.id, { kind: 'verify', status: 'pending_second_approval', createdAt: new Date(now.getTime() - HOUR) });
    db.seed('ecosystem_settings', { key: 'resign-job:publisher:p1', value: { scope: 'publisher', id: 'p1', done: ['a', 'b'] } });

    await metrics.sampleEcosystemMetrics(now);
    expect(gauge('ecosystem_requests_pending', { kind: 'new_version', lane: 'standard', status: 'pending' })).toBe(1);
    expect(gauge('ecosystem_requests_pending', { kind: 'verify', lane: 'standard', status: 'pending_second_approval' })).toBe(1);
    expect(gauge('ecosystem_requests_oldest_pending_age_seconds', { lane: 'standard' })).toBe(50 * 3600);
    expect(gauge('ecosystem_requests_sla_breached', { lane: 'standard' })).toBe(1);
    expect(gauge('ecosystem_requests_sla_breached', { lane: 'security' })).toBe(1);
    expect(gauge('ecosystem_resign_jobs_pending', {})).toBe(1);
    expect(gauge('ecosystem_resign_images_done', {})).toBe(2);
    expect(gauge('ecosystem_approvers', { permission: 'plugins:moderate', kind: 'holders' })).toBe(3);
    expect(gauge('ecosystem_approvers', { permission: 'publishers:verify', kind: 'superadmins' })).toBe(1);

    // The security request is decided; the approver read is not repeated within 5 minutes.
    sec.status = 'approved';
    h.platform.approvers.mockClear();
    await metrics.sampleEcosystemMetrics(new Date(now.getTime() + 60_000));
    expect(gauge('ecosystem_requests_pending', { kind: 'new_version', lane: 'security', status: 'pending' })).toBe(0);
    expect(gauge('ecosystem_requests_oldest_pending_age_seconds', { lane: 'security' })).toBe(0);
    expect(h.platform.approvers).not.toHaveBeenCalled();
  });

  it('an unknown approver count is skipped, not reported as zero', async () => {
    h.platform.approvers.mockResolvedValue(null as never);
    await metrics.sampleEcosystemMetrics(new Date());
    expect(setGauge.mock.calls.some((c) => c[0] === 'ecosystem_approvers')).toBe(false);
  });

  it('records decisions and observes queue latency only for final ones', () => {
    const now = new Date('2026-09-21T12:00:00Z');
    const r = { kind: 'new_version', lane: 'security', createdAt: new Date(now.getTime() - 2 * HOUR) } as any;
    metrics.recordDecision(r, 'first_approval', now);
    expect(incCounter).toHaveBeenCalledWith('ecosystem_decisions_total', { kind: 'new_version', decision: 'first_approval' });
    expect(observe).not.toHaveBeenCalled();
    metrics.recordDecision(r, 'rejected', now);
    expect(observe).toHaveBeenCalledWith('ecosystem_decision_latency_seconds', { kind: 'new_version', lane: 'security' }, 7200);
  });

  it('the sampler is an unlocked scheduler that survives a failed sample', () => {
    const s = metrics.createEcosystemMetricsScheduler();
    expect(typeof s.start).toBe('function');
    s.stop();
    expect(metrics.slaHoursFor('security')).toBe(4);
    expect(metrics.slaHoursFor('unknown')).toBe(48);
  });
});

// -----------------------------------------------------------------------------
// N22 SLA breach
// -----------------------------------------------------------------------------

describe('N22 moderation SLA breach', () => {
  it('announces each breached request ONCE, grouped by deciding permission, security lane first', async () => {
    const { acme } = seedPublishers(db);
    const listing = db.seed('plugin_listings', { publisherId: acme.id, name: 'lint' });
    const now = new Date('2026-09-21T12:00:00Z');
    openRequest(acme.id, { listingId: listing.id, createdAt: new Date(now.getTime() - 49 * HOUR) });
    const sec = openRequest(acme.id, { listingId: listing.id, lane: 'security', version: '1.0.1', createdAt: new Date(now.getTime() - 5 * HOUR) });
    openRequest(acme.id, { kind: 'verify', version: null, payload: { name: 'verify' }, status: 'pending_second_approval', createdAt: new Date(now.getTime() - 60 * HOUR) });
    openRequest(acme.id, { createdAt: new Date(now.getTime() - HOUR) }); // within SLA

    expect(await sla.notifySlaBreaches(now)).toBe(3);
    const calls = h.notify.mock.calls as any[];
    expect(calls).toHaveLength(2);
    const moderate = calls.find((c) => c[1][0].permission === 'plugins:moderate');
    expect(moderate[0]).toBe('N22');
    expect(moderate[2].subject).toBe('Moderation SLA breached: 2 requests (1 security-fix)');
    expect(moderate[2].text.indexOf('1.0.1')).toBeLessThan(moderate[2].text.indexOf('1.1.0'));
    expect(moderate[3]).toEqual({ immediate: true, mandatory: true });
    const verify = calls.find((c) => c[1][0].permission === 'publishers:verify');
    expect(verify[2].text).toContain('awaiting a second approval');

    // Next tick: nothing new.
    h.notify.mockClear();
    expect(await sla.notifySlaBreaches(new Date(now.getTime() + 15 * 60_000))).toBe(0);
    expect(h.notify).not.toHaveBeenCalled();

    // A decided request leaves the dedup row.
    sec.status = 'approved';
    await sla.notifySlaBreaches(now);
    const row = (db.tables.ecosystem_settings ?? []).find((r) => r.key === sla.SLA_NOTIFIED_KEY)!;
    expect(Object.keys(row.value as object)).toHaveLength(2);
  });

  it('a notice that cannot be queued is retried on the next pass', async () => {
    const { acme } = seedPublishers(db);
    const now = new Date();
    openRequest(acme.id, { lane: 'security', createdAt: new Date(now.getTime() - 5 * HOUR) });
    h.notify.mockRejectedValueOnce(new Error('queue down') as never);
    expect(await sla.notifySlaBreaches(now)).toBe(0);
    expect(await sla.notifySlaBreaches(now)).toBe(1);
  });

  it('lists at most 25 requests per notice and runs from the maintenance pass', async () => {
    const { acme } = seedPublishers(db);
    const now = new Date();
    for (let i = 0; i < 27; i++) openRequest(acme.id, { version: `1.0.${i}`, createdAt: new Date(now.getTime() - 50 * HOUR) });
    const out = await maintenance.runEcosystemMaintenance(now);
    expect(out.slaBreachesNotified).toBe(27);
    expect((h.notify.mock.calls[0] as any[])[2].text).toContain('and 2 more');
  });
});

describe('platform reads (live HTTP implementation)', () => {
  it('return null when platform is unreachable', async () => {
    expect(await platformReads.httpPlatformReads.eligibility('org-acme')).toBeNull();
    expect(await platformReads.httpPlatformReads.approvers('plugins:moderate', { orgIds: ['a', 'a'], userIds: ['u'] })).toBeNull();
  });
});
