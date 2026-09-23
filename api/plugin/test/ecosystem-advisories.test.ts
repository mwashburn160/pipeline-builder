// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security advisories and CVE response (
 * N20/N21) against the in-memory database: publisher drafts through
 * the `advisory` request kind, system-org publish (approve) / discard (reject)
 * / withdraw, the N21 fan-out with its idempotent delivery ledger and retry,
 * moderator drafts and edits, the CVE-rescan draft (deduplicated per listing
 * version and CVE set), the review-report seam, the install view's
 * warnings — and listed-version deprecation (publisher, system org, and
 * carried over from the source plugin row) with N14.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

import {
  DIGEST_A, SYSTEM_ORG, moderator, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness,
} from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const advisories = await import('../src/services/ecosystem/advisories.js');
const deprecation = await import('../src/services/ecosystem/version-deprecation.js');
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const installs = await import('../src/services/ecosystem/installs.js');
const consoleSvc = await import('../src/services/ecosystem/console.js');
const maintenance = await import('../src/services/ecosystem/maintenance.js');
await wireEcosystemHarness(h);

const { db } = h;

beforeEach(() => {
  db.reset();
  h.notify.mockClear();
  h.audit.mockClear();
  h.membership.mockClear();
});

async function rejects(p: Promise<unknown>, code: string): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    expect((err as { code: string }).code).toBe(code);
    return err as { code: string; message: string };
  }
  throw new Error(`expected ${code}`);
}

/** acme/lint with listed versions, and org-b installing it (minor from 1.0.0). */
function seedLint(opts: { versions?: string[]; installed?: boolean } = {}) {
  const { acme, official } = seedPublishers(db);
  const listing = db.seed('plugin_listings', { publisherId: acme.id, name: 'lint', summary: 'Lints', latestVersion: '1.1.0' });
  const vs = (opts.versions ?? ['1.0.0', '1.1.0']).map((version) => db.seed('plugin_listing_versions', {
    listingId: listing.id, version, imageDigest: DIGEST_A, imageRepository: 'public/acme/lint', publishedBy: 'system', vulnCritical: 0, vulnHigh: 0, scannedAt: new Date(),
  }));
  if (opts.installed !== false) {
    db.seed('plugin_install_policies', { orgId: 'org-b', allowedTiers: ['official', 'verified', 'community'] });
    db.seed('plugin_installs', { orgId: 'org-b', listingId: listing.id, versionPolicy: 'minor', pinnedVersion: '1.0.0', status: 'active', installedBy: 'u-b' });
  }
  return { acme, official, listing, versions: vs };
}

const ADVISORY = { affectedRange: '>=1.0.0 <1.2.0', severity: 'critical', summary: 'Token exfiltration', detailsMd: '# Impact\n\n**bad** <script>x</script>', cveIds: 'cve-2026-0001, GHSA-abcd-efgh-ijkl', fixedVersion: '1.2.0' };

async function submitDraft(listingId: string, over: Record<string, unknown> = {}) {
  return requestsSvc.submit(tenant() as any, { kind: 'advisory', listingId, advisory: { ...ADVISORY, ...over } });
}

const n21 = () => h.notify.mock.calls.filter((c) => c[0] === 'N21');

describe('publisher advisory drafts (the `advisory` request kind)', () => {
  it('stores a PRIVATE draft with a security-lane request, audited and announced at once (N24)', async () => {
    const { listing } = seedLint();
    const out = await submitDraft(listing.id);
    expect(out.autoApproved).toBe(false);
    expect(out.request).toMatchObject({ kind: 'advisory', lane: 'security', status: 'pending', listingId: listing.id });
    const [draft] = db.tables.plugin_advisories!;
    expect(draft).toMatchObject({
      state: 'draft',
      source: 'publisher',
      severity: 'critical',
      affectedRange: '>=1.0.0 <1.2.0',
      fixedVersion: '1.2.0',
      cveIds: ['CVE-2026-0001', 'GHSA-abcd-efgh-ijkl'],
      createdBy: 'u-acme',
    });
    // Sanitized server-side: raw HTML dropped, markdown rendered.
    expect(draft!.detailsHtml).toContain('<strong>bad</strong>');
    expect(draft!.detailsHtml).not.toContain('<script');
    expect((out.request.payload as any).advisoryId).toBe(draft!.id);
    expect(h.audit.mock.calls.map((c) => (c[0] as any).action)).toEqual(['plugin.request.submit', 'plugin.advisory.create']);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.advisory.create', targetId: draft!.id, affectedOrgId: 'org-acme' }));
    const n24 = h.notify.mock.calls.find((c) => c[0] === 'N24')!;
    expect(n24[3]).toEqual({ immediate: true, mandatory: true });
    // Nothing is public, and a second draft on the same listing is allowed.
    await submitDraft(listing.id, { severity: 'low', affectedRange: '1.0.0', fixedVersion: null });
    expect(db.tables.plugin_advisories).toHaveLength(2);
    expect((await advisories.publisherAdvisories(tenant() as any)).map((a) => a.state)).toEqual(['draft', 'draft']);
  });

  it('validates the fields and the listing, and needs publishers:manage', async () => {
    const { listing, official } = seedLint();
    const other = db.seed('plugin_listings', { publisherId: official.id, name: 'trivy' });
    await rejects(submitDraft(listing.id, { affectedRange: 'garbage here' }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { fixedVersion: '1.1.5' }), 'VALIDATION_ERROR'); // inside the range
    await rejects(submitDraft(listing.id, { fixedVersion: 'soon' }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { cveIds: ['not an id'] }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { cveIds: 42 }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { cveIds: [7] }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { severity: 'urgent' }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { summary: '  ' }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { summary: 'x'.repeat(301) }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { detailsMd: 5 }), 'VALIDATION_ERROR');
    await rejects(submitDraft(listing.id, { detailsMd: 'x'.repeat(40 * 1024) }), 'VALIDATION_ERROR');
    await rejects(submitDraft(other.id), 'NOT_FOUND');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'advisory', listingId: listing.id }), 'VALIDATION_ERROR');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'advisory' }), 'MISSING_REQUIRED_FIELD');
    await rejects(requestsSvc.submit(tenant({ permissions: ['plugins:publish'] }) as any, { kind: 'advisory', listingId: listing.id, advisory: ADVISORY }), 'INSUFFICIENT_PERMISSIONS');
    expect(db.tables.plugin_advisories ?? []).toHaveLength(0);
    expect(advisories.parseVulnIds(['CVE-2026-1', 'cve-2026-1', ''])).toEqual(['CVE-2026-1']);
    expect(() => advisories.parseVulnIds(Array.from({ length: 51 }, (_, i) => `CVE-2026-${1000 + i}`))).toThrow(/At most 50/);
  });

  it('removes the draft when its request cannot be stored', async () => {
    const { listing } = seedLint();
    db.failNextInsert('plugin_publish_requests', Object.assign(new Error('dup'), { code: '23505' }));
    await rejects(submitDraft(listing.id), 'DUPLICATE_ENTRY');
    expect(db.tables.plugin_advisories ?? []).toHaveLength(0);
  });

  it('a withdrawn or rejected request discards its draft; it never becomes public', async () => {
    const { listing } = seedLint();
    const a = await submitDraft(listing.id);
    await requestsSvc.withdraw(tenant() as any, a.request.id);
    const b = await submitDraft(listing.id, { summary: 'Second' });
    await decisions.reject(moderator() as any, b.request.id, 'not a vulnerability');
    expect(db.tables.plugin_advisories!.map((x) => [x.summary, x.state, x.publishedAt])).toEqual([
      ['Token exfiltration', 'withdrawn', null], ['Second', 'withdrawn', null],
    ]);
    expect(n21()).toHaveLength(0);
  });
});

describe('publishing (system org only) and the N21 fan-out', () => {
  it('approving the request publishes, audits and tells the publisher and every installing org at once', async () => {
    const { listing } = seedLint();
    const { request } = await submitDraft(listing.id);
    h.audit.mockClear();
    const out = await decisions.approve(moderator() as any, request.id, null);
    expect(out.executed).toBe(true);
    const [a] = db.tables.plugin_advisories!;
    expect(a).toMatchObject({ state: 'published', publishedBy: 'mod-1' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.advisory.publish',
      orgId: SYSTEM_ORG,
      affectedOrgId: 'org-acme',
      targetId: a!.id,
      details: expect.objectContaining({ listing: 'acme/lint', severity: 'critical', affectedRange: '>=1.0.0 <1.2.0' }),
    }));
    const calls = n21();
    expect(calls.map((c) => c[1])).toEqual([
      [{ kind: 'org_permission', orgId: 'org-acme', permission: 'publishers:manage' }],
      [{ kind: 'org_permission', orgId: 'org-b', permission: 'plugin_installs:manage', inheritFromRoot: true }],
    ]);
    for (const c of calls) expect(c[3]).toEqual({ immediate: true });
    expect((calls[1]![2] as any).subject).toBe('Security advisory (critical): acme/lint');
    expect((calls[1]![2] as any).text).toContain('Fixed in 1.2.0');
    expect(db.tables.plugin_advisory_deliveries!.map((d) => d.orgId).sort()).toEqual(['org-acme', 'org-b']);

    // Idempotent per (advisory, org): a retry tells nobody twice…
    h.notify.mockClear();
    expect(await advisories.fanOutAdvisory(a as any)).toBe(0);
    expect(n21()).toHaveLength(0);
    // …but reaches an org the interrupted fan-out missed (the maintenance retry).
    db.seed('plugin_install_policies', { orgId: 'org-c', allowedTiers: ['community'] });
    db.seed('plugin_installs', { orgId: 'org-c', listingId: listing.id, versionPolicy: 'pinned', pinnedVersion: '1.1.0', status: 'active', installedBy: 'u-c' });
    const out2 = await maintenance.runEcosystemMaintenance();
    expect(out2.advisoryOrgsNotified).toBe(1);
    expect(n21().map((c) => (c[1] as any)[0].orgId)).toEqual(['org-c']);
  });

  it('only the installs that reach an affected version hear; a failed send is retried later', async () => {
    const { listing } = seedLint();
    db.seed('plugin_installs', { orgId: 'org-pinned-old', listingId: listing.id, versionPolicy: 'pinned', pinnedVersion: '0.9.0', status: 'active', installedBy: 'x' });
    db.seed('plugin_listing_versions', { listingId: listing.id, version: '0.9.0', imageDigest: DIGEST_A, publishedBy: 'system' });
    const { request } = await submitDraft(listing.id, { affectedRange: '1.1.0', fixedVersion: null });
    h.notify.mockImplementation(async (event: unknown, recipients: any) => {
      if (event === 'N21' && recipients[0].orgId === 'org-b') throw new Error('relay down');
      return 'sent';
    });
    await decisions.approve(moderator() as any, request.id, null);
    expect(db.tables.plugin_advisory_deliveries!.map((d) => d.orgId)).toEqual(['org-acme']);
    h.notify.mockImplementation(async () => 'sent');
    h.notify.mockClear();
    expect(await advisories.retryAdvisoryFanOut()).toBe(1);
    expect(n21().map((c) => (c[1] as any)[0].orgId)).toEqual(['org-b']);
    // Outside the retry window nothing is resent.
    expect(await advisories.retryAdvisoryFanOut(new Date(Date.now() + 2 * advisories.FAN_OUT_RETRY_WINDOW_MS))).toBe(0);
  });

  it('refuses to publish twice, and a draft whose row vanished', async () => {
    const { listing, acme } = seedLint();
    const { request } = await submitDraft(listing.id);
    const r = db.tables.plugin_publish_requests!.find((x) => x.id === request.id)!;
    await rejects(advisories.publishAdvisory({ ...r, payload: { advisoryId: 'nope' } } as any, acme as any, 'm'), 'NOT_FOUND');
    await advisories.publishAdvisory(r as any, acme as any, 'm');
    await rejects(advisories.publishAdvisory(r as any, acme as any, 'm'), 'CONFLICT');
  });

  it('lookup warns on the published advisory, or refuses per blockOnAdvisory; withdrawal clears it', async () => {
    const { listing } = seedLint();
    const { request } = await submitDraft(listing.id, { severity: 'high' });
    await decisions.approve(moderator() as any, request.id, null);
    const [view] = (await installs.listInstalls(tenant({ orgId: 'org-b', permissions: ['plugins:read'] }) as any, {})).installs;
    expect(view).toMatchObject({ resolvedVersion: '1.1.0', blocked: null });
    expect(view!.warnings).toEqual([{ code: 'PLUGIN_ADVISORY', message: 'acme/lint@1.1.0 is affected by a high security advisory: Token exfiltration Fixed in 1.2.0.' }]);
    expect(view!.advisories).toEqual([{ id: db.tables.plugin_advisories![0]!.id, severity: 'high', summary: 'Token exfiltration', fixedVersion: '1.2.0', blocking: false }]);

    db.tables.plugin_install_policies![0]!.blockOnAdvisory = 'high';
    const [blocked] = (await installs.listInstalls(tenant({ orgId: 'org-b', permissions: ['plugins:read'] }) as any, {})).installs;
    expect(blocked).toMatchObject({ resolvedVersion: null, blocked: { reason: 'advisory' } });
    expect(blocked!.advisories).toEqual([expect.objectContaining({ severity: 'high', blocking: true })]);

    // Withdraw (system org): tells exactly the orgs that were told, and the block lifts.
    h.notify.mockClear();
    h.audit.mockClear();
    const id = db.tables.plugin_advisories![0]!.id;
    await rejects(advisories.withdrawAdvisory(moderator() as any, id, {}), 'MISSING_REQUIRED_FIELD');
    const withdrawn = await advisories.withdrawAdvisory(moderator() as any, id, { reason: 'false positive' });
    expect(withdrawn).toMatchObject({ state: 'withdrawn', requestId: null });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.advisory.withdraw', orgId: SYSTEM_ORG, affectedOrgId: 'org-acme' }));
    expect(n21().map((c) => (c[1] as any)[0].orgId)).toEqual(['org-acme', 'org-b']);
    expect((n21()[1]![2] as any).text).toContain('false positive');
    const [clear] = (await installs.listInstalls(tenant({ orgId: 'org-b', permissions: ['plugins:read'] }) as any, {})).installs;
    expect(clear).toMatchObject({ resolvedVersion: '1.1.0', blocked: null, warnings: [], advisories: [] });
    await rejects(advisories.withdrawAdvisory(moderator() as any, id, { reason: 'again' }), 'CONFLICT');
    await rejects(advisories.withdrawAdvisory(moderator() as any, 'missing', { reason: 'x' }), 'NOT_FOUND');
    await rejects(advisories.withdrawAdvisory(tenant() as any, id, { reason: 'x' }), 'INSUFFICIENT_PERMISSIONS');
  });

  it('a draft cannot be withdrawn (it is discarded by rejecting its request)', async () => {
    const { listing } = seedLint();
    await submitDraft(listing.id);
    await rejects(advisories.withdrawAdvisory(moderator() as any, db.tables.plugin_advisories![0]!.id, { reason: 'x' }), 'CONFLICT');
  });
});

describe('moderator drafts and edits', () => {
  it('opens a draft another manager must publish, edits it (the queue payload follows), audits both', async () => {
    const { listing } = seedLint();
    const out = await advisories.createModeratorDraft(moderator() as any, { listingId: listing.id, affectedRange: '1.0.0', severity: 'medium', summary: 'Weak default' });
    expect(out.advisory).toMatchObject({ state: 'draft', source: 'moderator', listingName: 'lint', publisherHandle: 'acme', affectedVersions: ['1.0.0'], requestId: out.request.id });
    expect(out.request).toMatchObject({ kind: 'advisory', lane: 'security', submittedBy: 'mod-1', submittedOrgId: SYSTEM_ORG });
    // N20 to the moderators, the author excluded.
    expect(h.notify.mock.calls.find((c) => c[0] === 'N20')![1]).toEqual([{ kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: 'org-acme', excludeUserIds: ['mod-1'] }]);
    await rejects(decisions.approve(moderator() as any, out.request.id, null), 'SEPARATION_OF_DUTIES');

    const edited = await advisories.editDraft(moderator('mod-2') as any, out.advisory.id, { affectedRange: '>=1.0.0 <1.1.0', severity: 'high', fixedVersion: '1.1.0' });
    expect(edited).toMatchObject({ affectedRange: '>=1.0.0 <1.1.0', severity: 'high', summary: 'Weak default', fixedVersion: '1.1.0' });
    expect(db.tables.plugin_publish_requests!.find((r) => r.id === out.request.id)!.payload).toMatchObject({ severity: 'high', affectedRange: '>=1.0.0 <1.1.0' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.advisory.update', actorId: 'mod-2', details: expect.objectContaining({ fields: ['affectedRange', 'severity', 'fixedVersion'] }) }));
    await rejects(advisories.editDraft(moderator('mod-2') as any, out.advisory.id, { fixedVersion: '1.0.0' }), 'VALIDATION_ERROR');

    // The console's request detail carries the draft.
    const detail = await consoleSvc.requestDetail(moderator('mod-2') as any, out.request.id);
    expect(detail.advisory).toMatchObject({ id: out.advisory.id, severity: 'high' });

    await decisions.approve(moderator('mod-2') as any, out.request.id, null);
    await rejects(advisories.editDraft(moderator('mod-2') as any, out.advisory.id, { summary: 'late' }), 'CONFLICT');
    await rejects(advisories.editDraft(moderator('mod-2') as any, 'missing', {}), 'NOT_FOUND');
    await rejects(advisories.editDraft(tenant() as any, out.advisory.id, {}), 'INSUFFICIENT_PERMISSIONS');
    await rejects(advisories.createModeratorDraft(tenant() as any, {}), 'INSUFFICIENT_PERMISSIONS');
    await rejects(advisories.createModeratorDraft(moderator() as any, { listingId: 'missing' }), 'NOT_FOUND');
    await rejects(advisories.createModeratorDraft(moderator() as any, {}), 'MISSING_REQUIRED_FIELD');

    expect((await advisories.consoleAdvisories({ state: 'published' })).map((a) => a.id)).toEqual([out.advisory.id]);
    expect(await advisories.consoleAdvisories({ state: 'draft', listingId: listing.id })).toEqual([]);
  });
});

describe('the CVE rescan opens private drafts', () => {
  const finding = (id: string, severity: 'critical' | 'high' = 'high') => ({ id, severity, packageName: 'openssl', packageVersion: '3.0.0' });

  it('opens one per listing version and CVE set, deduplicated against every covering advisory, with N20', async () => {
    const { listing, versions } = seedLint();
    const lv = versions[1]!;
    const a = await advisories.openRescanDraft({ listingVersion: lv as any, findings: [finding('CVE-2026-1', 'critical'), finding('CVE-2026-2'), finding('CVE-2026-2')] });
    expect(a).toMatchObject({ state: 'draft', source: 'cve_rescan', severity: 'critical', affectedRange: '1.1.0', cveIds: ['CVE-2026-1', 'CVE-2026-2'], createdBy: 'system' });
    expect(a!.detailsHtml).toContain('<table>');
    const req = db.tables.plugin_publish_requests!.find((r) => r.kind === 'advisory')!;
    expect(req).toMatchObject({ lane: 'security', submittedBy: 'system', submittedOrgId: SYSTEM_ORG, listingId: listing.id });
    expect(req.payload).toMatchObject({ listingVersionId: lv.id, version: '1.1.0', source: 'cve_rescan' });
    const n20 = h.notify.mock.calls.find((c) => c[0] === 'N20')!;
    expect(n20[1]).toEqual([
      { kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: 'org-acme' },
      { kind: 'org_permission', orgId: 'org-acme', permission: 'publishers:manage' },
    ]);
    expect(n20[3]).toEqual({ immediate: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.advisory.create', actorId: 'system', details: expect.objectContaining({ source: 'cve_rescan', version: '1.1.0' }) }));

    // The same findings again: nothing new.
    expect(await advisories.openRescanDraft({ listingVersion: lv as any, findings: [finding('cve-2026-1', 'critical')] })).toBeNull();
    // A discarded draft's ids stay covered ("not applicable" sticks).
    await decisions.reject(moderator() as any, req.id, 'not reachable');
    expect(await advisories.openRescanDraft({ listingVersion: lv as any, findings: [finding('CVE-2026-2')] })).toBeNull();
    // Only the NEW id makes a draft.
    const b = await advisories.openRescanDraft({ listingVersion: lv as any, findings: [finding('CVE-2026-2'), finding('CVE-2026-3')] });
    expect(b).toMatchObject({ cveIds: ['CVE-2026-3'], severity: 'high' });
  });

  it('skips yanked versions, delisted listings and suspended publishers, and never throws', async () => {
    const { listing, versions, acme } = seedLint();
    expect(await advisories.openRescanDraft({ listingVersion: { ...versions[0], yankedAt: new Date() } as any, findings: [finding('CVE-2026-9')] })).toBeNull();
    listing.state = 'suspended';
    expect(await advisories.openRescanDraft({ listingVersion: versions[0] as any, findings: [finding('CVE-2026-9')] })).toBeNull();
    listing.state = 'listed';
    acme.suspendedAt = new Date();
    expect(await advisories.openRescanDraft({ listingVersion: versions[0] as any, findings: [finding('CVE-2026-9')] })).toBeNull();
    acme.suspendedAt = null;
    expect(await advisories.openRescanDraft({ listingVersion: versions[0] as any, findings: [] })).toBeNull();
    db.failNextInsert('plugin_advisories', new Error('db down'));
    expect(await advisories.openRescanDraft({ listingVersion: versions[0] as any, findings: [finding('CVE-2026-9')] })).toBeNull();
    // A request that can't be stored takes its draft with it.
    db.failNextInsert('plugin_publish_requests', new Error('db down'));
    expect(await advisories.openRescanDraft({ listingVersion: versions[0] as any, findings: [finding('CVE-2026-9')] })).toBeNull();
    expect(db.tables.plugin_advisories ?? []).toHaveLength(0);
  });
});

describe('security-flagged review reports (the seam)', () => {
  const report = (listingId: string, over: Record<string, unknown> = {}) => ({
    reviewId: 'rev-1',
    reportId: 'rep-1',
    listingId,
    publisherId: 'p',
    publisherOrgId: 'org-acme',
    publisherHandle: 'acme',
    listingName: 'lint',
    version: '1.0.0',
    details: 'exploit steps',
    reportedBy: { userId: 'u-reporter', orgId: 'org-z' },
    reportedAt: new Date(),
    ...over,
  });

  it('opens one private draft per review, never naming the reporter', async () => {
    const { listing } = seedLint();
    const first = await advisories.openReviewAdvisoryDraft(report(listing.id) as any);
    expect((await advisories.openReviewAdvisoryDraft(report(listing.id, { reportId: 'rep-2' }) as any)).id).toBe(first.id);
    expect(db.tables.plugin_advisories).toHaveLength(1);
    const [a] = db.tables.plugin_advisories!;
    expect(a).toMatchObject({ source: 'review', affectedRange: '1.0.0', severity: 'high', createdBy: 'system', detailsMd: null });
    const req = db.tables.plugin_publish_requests!.find((r) => r.kind === 'advisory')!;
    expect(req.payload).toMatchObject({ reviewId: 'rev-1', reportId: 'rep-1', reportDetails: 'exploit steps' });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('u-reporter');
    // sends N19; the seam sends nothing itself.
    expect(h.notify.mock.calls.filter((c) => c[0] === 'N20' || c[0] === 'N24')).toHaveLength(0);
    // Without a version, the listing's latest.
    const b = await advisories.openReviewAdvisoryDraft(report(listing.id, { reviewId: 'rev-2', version: null }) as any);
    expect(b.affectedRange).toBe('1.1.0');
    listing.latestVersion = null;
    await rejects(advisories.openReviewAdvisoryDraft(report(listing.id, { reviewId: 'rev-3', version: null }) as any), 'CONFLICT');
  });
});

describe('advisory lists', () => {
  it('the publisher sees its own advisories in every state, system drafts without their author', async () => {
    const { listing, versions } = seedLint();
    await submitDraft(listing.id);
    await advisories.openRescanDraft({ listingVersion: versions[0] as any, findings: [{ id: 'CVE-2026-7', severity: 'high', packageName: 'x', packageVersion: '1' }] });
    await advisories.createModeratorDraft(moderator() as any, { listingId: listing.id, affectedRange: '1.0.0', severity: 'low', summary: 'm' });
    const list = await advisories.publisherAdvisories(tenant() as any);
    expect(list.map((a) => [a.source, a.createdBy]).sort()).toEqual([['cve_rescan', 'system'], ['moderator', 'system'], ['publisher', 'u-acme']]);
    expect(list.every((a) => a.requestId !== null)).toBe(true);
    expect(await advisories.publisherAdvisories(tenant({ orgId: 'org-nobody' }) as any)).toEqual([]);
    // A plain member (plugins:read) reads its own publisher's advisories — never the embargoed drafts.
    expect(await advisories.publisherAdvisories(tenant({ permissions: ['plugins:read'] }) as any)).toEqual([]);
    await rejects(advisories.publisherAdvisories(tenant({ permissions: [] }) as any), 'INSUFFICIENT_PERMISSIONS');
  });
});

describe('listed-version deprecation', () => {
  it('the publisher deprecates its own listed version at once: lookup warns, installers get N14, audited', async () => {
    const { listing } = seedLint();
    const out = await deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { version: '1.1.0', message: ' Use 2.x ' });
    expect(out.versions!.find((v) => v.version === '1.1.0')).toMatchObject({ deprecationMessage: 'Use 2.x', deprecatedAt: expect.any(String) });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.version.deprecate', orgId: 'org-acme', affectedOrgId: 'org-acme', targetType: 'plugin-listing-version', details: expect.objectContaining({ version: '1.1.0', deprecated: true, via: 'publisher' }),
    }));
    const n14 = h.notify.mock.calls.filter((c) => c[0] === 'N14');
    expect(n14.map((c) => (c[1] as any)[0].orgId)).toEqual(['org-b']);
    expect((n14[0]![2] as any).text).toContain('Use 2.x');
    const [view] = (await installs.listInstalls(tenant({ orgId: 'org-b', permissions: ['plugins:read'] }) as any, {})).installs;
    expect(view!.warnings.map((w) => w.code)).toEqual(['PLUGIN_DEPRECATED']);

    // Re-deprecating with a new message updates it without a second N14.
    h.notify.mockClear();
    await deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { version: '1.1.0', message: 'Use 3.x' });
    expect(h.notify.mock.calls.filter((c) => c[0] === 'N14')).toHaveLength(0);
    expect(db.tables.plugin_listing_versions!.find((v) => v.version === '1.1.0')!.deprecationMessage).toBe('Use 3.x');
  });

  it('refuses without a message, a version, the permission, from a team, or on another publisher\'s listing', async () => {
    const { listing, official } = seedLint();
    const other = db.seed('plugin_listings', { publisherId: official.id, name: 'trivy' });
    await rejects(deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { version: '1.1.0' }), 'MISSING_REQUIRED_FIELD');
    await rejects(deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { version: '1.1.0', message: 'x'.repeat(501) }), 'VALIDATION_ERROR');
    await rejects(deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { version: '1.1.0', message: 3 }), 'VALIDATION_ERROR');
    await rejects(deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { message: 'x' }), 'MISSING_REQUIRED_FIELD');
    await rejects(deprecation.deprecateOwnListedVersion(tenant() as any, listing.id, { version: '9.9.9', message: 'x' }), 'NOT_FOUND');
    await rejects(deprecation.deprecateOwnListedVersion(tenant() as any, other.id, { version: '1.0.0', message: 'x' }), 'NOT_FOUND');
    await rejects(deprecation.deprecateOwnListedVersion(tenant({ permissions: ['publishers:manage'] }) as any, listing.id, { version: '1.1.0', message: 'x' }), 'INSUFFICIENT_PERMISSIONS');
    await rejects(deprecation.deprecateOwnListedVersion(tenant({ parentOrgId: 'org-root' }) as any, listing.id, { version: '1.1.0', message: 'x' }), 'PUBLISHER_ROOT_ORG_REQUIRED');
  });

  it('the system org deprecates or clears any listed version', async () => {
    const { listing } = seedLint();
    await deprecation.setListedVersionDeprecation(moderator() as any, listing.id, '1.0.0', {});
    expect(db.tables.plugin_listing_versions!.find((v) => v.version === '1.0.0')).toMatchObject({ deprecatedAt: expect.any(Date), deprecationMessage: null });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.version.deprecate', orgId: SYSTEM_ORG, affectedOrgId: 'org-acme', details: expect.objectContaining({ via: 'system_org' }) }));
    h.audit.mockClear();
    await deprecation.setListedVersionDeprecation(moderator() as any, listing.id, '1.0.0', { deprecated: false });
    expect(db.tables.plugin_listing_versions!.find((v) => v.version === '1.0.0')).toMatchObject({ deprecatedAt: null });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ deprecated: false }) }));
    h.audit.mockClear();
    await deprecation.setListedVersionDeprecation(moderator() as any, listing.id, '1.0.0', { deprecated: false });
    expect(h.audit).not.toHaveBeenCalled();
    await rejects(deprecation.setListedVersionDeprecation(moderator() as any, listing.id, '7.0.0', {}), 'NOT_FOUND');
    await rejects(deprecation.setListedVersionDeprecation(tenant() as any, listing.id, '1.0.0', {}), 'INSUFFICIENT_PERMISSIONS');
  });

  it('deprecating the source plugin row carries over to its listed versions', async () => {
    const { versions } = seedLint();
    versions[1]!.sourcePluginId = 'plugin-row-1';
    expect(await deprecation.deprecateListedFromSource({ id: 'plugin-row-1', orgId: 'org-acme', deprecationMessage: 'EOL' }, 'u-acme')).toBe(1);
    expect(versions[1]).toMatchObject({ deprecatedAt: expect.any(Date), deprecationMessage: 'EOL' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.version.deprecate', details: expect.objectContaining({ via: 'source_plugin' }) }));
    // Already deprecated: nothing more.
    expect(await deprecation.deprecateListedFromSource({ id: 'plugin-row-1', orgId: 'org-acme' }, 'u-acme')).toBe(0);
    expect(await deprecation.deprecateListedFromSource({ id: 'no-listing', orgId: 'org-acme' }, 'u-acme')).toBe(0);
  });
});
