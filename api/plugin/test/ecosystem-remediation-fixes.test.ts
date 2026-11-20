// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly CVE remediation meets the plugin ecosystem
 * (services/ecosystem/remediation-fixes, services/remediation-notices):
 *
 *  - an Official (system-org) fix opens a new-version publish request on its
 *    listing (digest pinned, remediation_id set), the seeded "Remediation
 *    fixes" rule approves it through the ecosystem gates, the listing version
 *    goes live and Stage 3 starts for every org using the listing — so a
 *    tenant's install moves to it;
 *  - the `remediationOnly` rule condition (evaluator, widening, console schema);
 *  - a third-party listing is never rebuilt and gets a fix request (N40), its
 *    installers told;
 *  - the deploy/plugins/** patch export;
 *  - the N36–N39 notices: recipients, digest, dedupe, the operator knob.
 *
 * The database is the in-memory ecosystem fake; the relay, the pipeline
 * service and the plugin-sources writer are spies.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PIPELINE_INTERNAL, SYSTEM_PLUGIN_REMEDIATION, buildContractPath } from '@pipeline-builder/api-core';

import { DIGEST_A, DIGEST_B, SYSTEM_ORG, loader, moderator, pluginRow, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

process.env.PLATFORM_FRONTEND_URL = 'https://pb.example.com';

const h = setupEcosystemHarness();
const putArtifact = jest.fn(async (_key: string, _body: Buffer | string) => undefined);

const fixes = await import('../src/services/ecosystem/remediation-fixes.js');
const notices = await import('../src/services/remediation-notices.js');
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const policy = await import('../src/services/ecosystem/policy.js');
const consoleSvc = await import('../src/services/ecosystem/console.js');
const securityNotices = await import('../src/services/plugin-security-notifications.js');
const { installAdmits } = await import('@pipeline-builder/pipeline-data');
await wireEcosystemHarness(h);

const { db } = h;
const REMEDIATION_RULE = '00000000-0000-4000-8000-00000000a003';
const OFFICIAL_RULE = '00000000-0000-4000-8000-00000000a002';

const seen = new Map<string, Set<string>>();
const dedupe = {
  claimNew: jest.fn(async (key: string, members: readonly string[]) => {
    const set = seen.get(key) ?? new Set<string>();
    seen.set(key, set);
    const fresh = members.filter((m) => !set.has(m));
    fresh.forEach((m) => set.add(m));
    return fresh;
  }),
};

const pipelinePost = jest.fn(async (path: string, body: any) => ({
  statusCode: 200,
  headers: {},
  body: { data: { remediationId: /plugin-remediations\/([^/]+)\//.exec(path)![1], created: true, orgDefault: null, counts: Object.fromEntries(['proposed', 'change_requested', 'queued', 'moved', 'failed', 'rolled_back', 'rollback_blocked', 'skipped_opt_out', 'skipped_runner', 'dismissed', 'superseded'].map((s) => [s, 0])) }, _sent: body },
}));

function seedRules(): void {
  db.seed('ecosystem_auto_approval_rules', {
    id: OFFICIAL_RULE,
    name: 'Official catalog',
    enabled: true,
    createdBy: 'system',
    approvedBy: 'system',
    conditions: { seeded: 'official_catalog', requestKinds: ['new_version', 'listing_update'], publisherTiers: ['official'], bumps: ['patch', 'minor'], submitterServiceAccount: 'official-catalog-loader', textOnlyListingUpdates: true, maxPerListingPerDay: 1, maxPerDay: 50, instanceFlag: 'OFFICIAL_AUTO_APPROVAL_ENABLED' },
  });
  // The seed in postgres-init.sql (contracts §2.1).
  db.seed('ecosystem_auto_approval_rules', {
    id: REMEDIATION_RULE,
    name: 'Remediation fixes',
    enabled: true,
    createdBy: 'system',
    approvedBy: 'system',
    conditions: { seeded: 'remediation_fixes', requestKinds: ['new_version'], publisherTiers: ['official'], bumps: ['patch', 'minor'], submitterServiceAccount: 'plugin-remediation', remediationOnly: true },
  });
}

const finding = (id: string, severity: 'critical' | 'high', kev = false) => ({
  id, severity, packageName: 'openssl', packageVersion: '3.0.1', packageType: 'deb', purl: 'pkg:deb/debian/openssl@3.0.1', locations: [], fixedIn: ['3.0.2'], ...(kev ? { kev } : {}),
});
const cleared = (id: string) => ({ id, purl: 'pkg:deb/debian/openssl@3.0.1', packageName: 'openssl', packageType: 'deb', fromVersion: '3.0.1', toVersion: '3.0.2', method: 'rebuild' });
const remaining = (id: string, over: Record<string, unknown> = {}) => ({
  id, severity: 'critical' as const, purl: 'pkg:golang/golang.org/x/net@0.1.0', packageName: 'golang.org/x/net', packageType: 'go-module' as const, packageVersion: '0.1.0', fixedIn: ['0.17.0'], reason: 'compiled_binary' as const, ...over,
});

/** An Official listing `lint` at 1.0.0, a published system-org fix 1.0.1 and its remediation row. */
function officialFix(over: Record<string, unknown> = {}) {
  const { official, acme } = seedPublishers(db);
  const listing = db.seed('plugin_listings', { publisherId: official.id, name: 'lint', latestVersion: '1.0.0', summary: 'Lints code.', description: 'Lints code.', category: 'quality', keywords: ['lint'], license: 'MIT', sourceUrl: 'https://github.com/acme/lint', readmeHtml: '<h1>Lint</h1>' });
  db.seed('plugin_listing_versions', { listingId: listing.id, version: '1.0.0', imageDigest: DIGEST_B, imageRepository: 'public/pipeline-builder/lint', specSnapshot: {}, publishedBy: 'system', vulnCritical: 2, vulnHigh: 1 });
  db.seed('ecosystem_settings', { key: 'bootstrap', value: { openedAt: null, closedAt: new Date().toISOString(), reason: 'first_reviewed_decision', approved: 0 } });
  seedRules();
  const flagged = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.0', imageDigest: DIGEST_B, vulnCritical: 2, vulnHigh: 1 }));
  const fix = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.1', createdBy: SYSTEM_PLUGIN_REMEDIATION, ...over }));
  const remediation = db.seed('plugin_remediations', {
    orgId: SYSTEM_ORG,
    pluginId: flagged.id,
    pluginName: 'lint',
    fromVersion: '1.0.0',
    findingsHash: 'f'.repeat(64),
    stage: 'published',
    outcome: 'cleared',
    toVersion: '1.0.1',
    toPluginId: fix.id,
    targeted: [finding('CVE-2026-0001', 'critical', true), finding('CVE-2026-0002', 'critical'), finding('CVE-2026-0003', 'high')],
    cleared: [cleared('CVE-2026-0001'), cleared('CVE-2026-0002'), cleared('CVE-2026-0003')],
    remaining: [],
    publishRequestId: null,
    exportKey: null,
    createdBy: SYSTEM_PLUGIN_REMEDIATION,
  });
  return { official, acme, listing, flagged, fix, remediation };
}

beforeEach(() => {
  db.reset();
  seen.clear();
  jest.clearAllMocks();
  securityNotices.setNoticeDedupeStoreForTests(dedupe);
  fixes.setRemediationPipelineClientForTests({ post: pipelinePost } as never);
  fixes.setSuggestedPatchReaderForTests(async () => '--- a/Dockerfile\n+++ b/Dockerfile\n-RUN apt-get install -y openssl\n+RUN apt-get install -y openssl=3.0.2\n');
});

afterEach(() => {
  delete process.env.PLUGIN_REMEDIATION_ENABLED;
});

// -----------------------------------------------------------------------------
// Official fixes
// -----------------------------------------------------------------------------

describe('Official catalog fix → listing version → tenant installs', () => {
  it('opens a digest-pinned new-version request with remediation_id, auto-approves it through the remediation rule, and starts the rollout for every org using the listing', async () => {
    const { listing, fix, remediation } = officialFix();
    // A tenant installing the listing with a minor policy from 1.0.0.
    const install = db.seed('plugin_installs', { orgId: 'org-acme', listingId: listing.id, versionPolicy: 'minor', pinnedVersion: '1.0.0', resolvedVersion: '1.0.0', status: 'active' });

    const out = await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_A });
    expect(out).toEqual({ requestId: expect.any(String) });

    const req = db.tables.plugin_publish_requests!.find((r) => r.id === out!.requestId)!;
    expect(req).toMatchObject({
      kind: 'new_version',
      status: 'approved',
      autoRuleId: REMEDIATION_RULE,
      digest: DIGEST_A,
      remediationId: remediation.id,
      submittedOrgId: SYSTEM_ORG,
      payload: expect.objectContaining({ submitter: { principalType: 'service_account', name: 'plugin-remediation' }, remediation: { remediationId: remediation.id } }),
    });
    // The version is frozen at the pinned digest, and the listing version is live at it.
    expect(db.tables.plugins!.find((p) => p.id === fix.id)!.frozenAt).toBeInstanceOf(Date);
    const published = db.tables.plugin_listing_versions!.find((v) => v.version === '1.0.1')!;
    expect(published).toMatchObject({ listingId: listing.id, sourcePluginId: fix.id });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.submit', actorId: SYSTEM_PLUGIN_REMEDIATION, details: expect.objectContaining({ remediationId: remediation.id }) }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.auto-approve', details: expect.objectContaining({ autoRuleId: REMEDIATION_RULE }) }));

    // Stage 3 across every org using the listing (orgId null), with what it clears.
    expect(pipelinePost).toHaveBeenCalledTimes(1);
    const [path, body] = pipelinePost.mock.calls[0]!;
    expect(path).toBe(buildContractPath(PIPELINE_INTERNAL.startRemediationRollout, { remediationId: remediation.id }));
    expect(body).toEqual({
      orgId: null,
      plugin: 'lint',
      publisher: 'pipeline-builder',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
      toPluginId: fix.id,
      advisoryIds: ['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0003'],
      criticalCleared: 2,
      highCleared: 1,
      kev: true,
    });
    expect(db.tables.plugin_remediations![0]).toMatchObject({ publishRequestId: out!.requestId, stage: 'rolling_out' });

    // The tenant's install admits the new listing version: its pipelines move to it.
    const all = db.tables.plugin_listing_versions!.filter((v) => v.listingId === listing.id);
    expect(installAdmits(install as never, '1.0.1', all as never)).toBe(true);
    expect(db.tables.plugin_listings!.find((l) => l.id === listing.id)!.latestVersion).toBe('1.0.1');

    // Idempotent: the same remediation answers its request and starts nothing new.
    expect(await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_A })).toEqual(out);
    expect(db.tables.plugin_publish_requests!.filter((r) => r.kind === 'new_version')).toHaveLength(1);
  });

  it('leaves a fix that fails the ecosystem vulnerability gate for a manager, and starts no rollout', async () => {
    const { fix, remediation } = officialFix({ vulnHigh: 3 });
    const out = await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_A });
    const req = db.tables.plugin_publish_requests!.find((r) => r.id === out!.requestId)!;
    expect(req).toMatchObject({ status: 'pending', remediationId: remediation.id, autoRuleId: null });
    expect(db.tables.plugin_listing_versions!.find((v) => v.version === '1.0.1')).toBeUndefined();
    expect(pipelinePost).not.toHaveBeenCalled();

    // A manager's approval later publishes it, and the execution of that
    // approval starts the rollout.
    // (An Official version takes two moderators.)
    expect(await decisions.approve(moderator('mod-1') as never, req.id as string, null)).toMatchObject({ executed: false });
    expect(pipelinePost).not.toHaveBeenCalled();
    expect(await decisions.secondApprove(moderator('mod-2') as never, req.id as string, null)).toMatchObject({ executed: true });
    expect(db.tables.plugin_listing_versions!.find((v) => v.version === '1.0.1')).toBeDefined();
    expect(pipelinePost).toHaveBeenCalledTimes(1);
    expect(pipelinePost.mock.calls[0]![0]).toBe(buildContractPath(PIPELINE_INTERNAL.startRemediationRollout, { remediationId: remediation.id }));
    expect(db.tables.plugin_remediations![0]).toMatchObject({ stage: 'rolling_out' });
    // The hook is a no-op for a request no remediation opened.
    await fixes.onRemediationRequestPublished({ kind: 'new_version', remediationId: null });
    expect(pipelinePost).toHaveBeenCalledTimes(1);
  });

  it('lists nothing when the digest moved, the remediation is a tenant\'s, there is no Official listing, or remediation is off', async () => {
    const { fix, remediation } = officialFix();
    expect(await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_B })).toBeNull();
    expect(db.tables.plugin_publish_requests ?? []).toHaveLength(0);

    remediation.orgId = 'org-acme';
    expect(await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_A })).toBeNull();
    remediation.orgId = SYSTEM_ORG;

    process.env.PLUGIN_REMEDIATION_ENABLED = 'false';
    expect(await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_A })).toBeNull();
    delete process.env.PLUGIN_REMEDIATION_ENABLED;

    db.tables.plugin_listings!.forEach((l) => { l.name = 'other'; });
    expect(await fixes.openOfficialListingFix({ remediationId: remediation.id, toPluginId: fix.id, toVersion: '1.0.1', digest: DIGEST_A })).toBeNull();
    expect(pipelinePost).not.toHaveBeenCalled();
  });

  it('opens remediation requests only for the plugin-remediation service account, and never takes the id from a request body', async () => {
    const { fix, remediation } = officialFix();
    await expect(requestsSvc.submitRemediationFix(loader() as never, fix.id, remediation.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    await expect(requestsSvc.submitRemediationFix(tenant() as never, fix.id, remediation.id)).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });

    // The loader submitting the same version with a forged id: an ordinary request.
    const { request } = await requestsSvc.submit(loader() as never, { kind: 'new_version', pluginId: fix.id, remediationId: remediation.id });
    const row = db.tables.plugin_publish_requests!.find((r) => r.id === request.id)!;
    expect(row.remediationId).toBeNull();
    expect(row.payload.remediation).toBeUndefined();
    // …so the remediation rule declines it (the Official rule takes it on its own terms).
    expect(row.autoRuleId).not.toBe(REMEDIATION_RULE);
  });
});

describe('the remediationOnly condition', () => {
  const ctx = {
    kind: 'new_version',
    publisherTier: 'official' as const,
    submitterServiceAccount: 'plugin-remediation',
    bump: 'patch' as const,
    breaking: false,
    vuln: { newCritical: 0, newHigh: 0 },
    signed: true,
    scanned: true,
    listingLive: true,
    approvedToday: 0,
    approvedTodayForListing: 0,
    flagOn: true,
  };
  const conditions = { requestKinds: ['new_version'], publisherTiers: ['official' as const], bumps: ['patch' as const, 'minor' as const], submitterServiceAccount: 'plugin-remediation', remediationOnly: true };

  it('admits only requests opened by a remediation, and still applies the vulnerability gate', () => {
    expect(policy.evaluateAutoRule(conditions, { ...ctx, remediation: true })).toEqual({ eligible: true, reasons: [] });
    expect(policy.evaluateAutoRule(conditions, { ...ctx, remediation: false }).reasons).toContain('only requests opened by a remediation qualify');
    expect(policy.evaluateAutoRule(conditions, ctx).eligible).toBe(false);
    expect(policy.evaluateAutoRule(conditions, { ...ctx, remediation: true, vuln: { newCritical: 1, newHigh: 0 } }).reasons).toContain('1 new critical vulnerabilities');
    expect(policy.evaluateAutoRule({ ...conditions, remediationOnly: undefined }, ctx).eligible).toBe(true);
  });

  it('dropping it widens the rule (a second manager), and the console accepts it', () => {
    expect(policy.widensRule(conditions, { ...conditions, remediationOnly: false })).toBe(true);
    expect(policy.widensRule({ ...conditions, remediationOnly: false }, conditions)).toBe(false);
    expect(consoleSvc.AutoRuleConditionsSchema.parse(conditions)).toMatchObject({ remediationOnly: true });
    expect(consoleSvc.AutoRuleConditionsSchema.safeParse({ ...conditions, remediationOnly: 'yes' }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The deploy/plugins/** export
// -----------------------------------------------------------------------------

describe('the patch export for deploy/plugins/** maintainers', () => {
  const diff = [
    'diff --git a/Dockerfile b/Dockerfile',
    'index 1111111..2222222 100644',
    '--- a/Dockerfile',
    '+++ b/Dockerfile',
    '@@ -1,2 +1,2 @@',
    '-RUN apt-get install -y openssl',
    '+RUN apt-get install -y openssl=3.0.2',
    '--- package.json\t2026-01-01',
    '+++ package.json\t2026-01-01',
  ].join('\n');

  it('re-roots every path at the plugin\'s repository directory', () => {
    const out = fixes.officialExportDiff(diff, 'lint', 'quality');
    expect(out).toContain('diff --git a/deploy/plugins/quality/lint/Dockerfile b/deploy/plugins/quality/lint/Dockerfile');
    expect(out).toContain('--- a/deploy/plugins/quality/lint/Dockerfile\n+++ b/deploy/plugins/quality/lint/Dockerfile');
    expect(out).toContain('--- a/deploy/plugins/quality/lint/package.json\t2026-01-01');
    expect(out).toContain('+RUN apt-get install -y openssl=3.0.2');
    expect(fixes.officialExportDiff('--- /dev/null\n+++ b/x.txt', 'lint')).toBe('--- /dev/null\n+++ b/deploy/plugins/lint/x.txt');
    expect(() => fixes.officialExportDiff('--- a/../../etc/passwd\n+++ b/../../etc/passwd', 'lint')).toThrow('escapes');
    expect(() => fixes.officialExportDiff('+++ /etc/passwd', 'lint')).toThrow('escapes');
    expect(() => fixes.officialPluginDir('../x')).toThrow();
  });

  it('stores it with the remediation for system-org admins, and only for system-org remediations', async () => {
    const { flagged, remediation } = officialFix();
    const key = await fixes.storeOfficialExport(remediation.id, diff, putArtifact, 'quality');
    expect(key).toBe(`${SYSTEM_ORG}/${flagged.id}/1.0.0/remediations/${remediation.id}/export.diff`);
    expect(putArtifact).toHaveBeenCalledWith(key!, expect.stringContaining('deploy/plugins/quality/lint/Dockerfile'));
    expect(db.tables.plugin_remediations![0]!.exportKey).toBe(key);

    remediation.orgId = 'org-acme';
    expect(await fixes.storeOfficialExport(remediation.id, diff, putArtifact)).toBeNull();
    expect(putArtifact).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Third-party listings
// -----------------------------------------------------------------------------

describe('a listed third-party plugin', () => {
  function thirdParty() {
    const { acme, official } = seedPublishers(db);
    const listing = db.seed('plugin_listings', { publisherId: acme.id, name: 'scan', latestVersion: '2.0.0' });
    db.seed('plugin_listing_versions', { listingId: listing.id, version: '2.0.0', imageDigest: DIGEST_B, imageRepository: 'public/acme/scan' });
    db.seed('plugin_installs', { orgId: 'org-user', listingId: listing.id, versionPolicy: 'minor', resolvedVersion: '2.0.0', status: 'active' });
    return { acme, official, listing };
  }

  it('is never remediated by the platform: its listing versions get a fix request', () => {
    expect(fixes.remediationOwnership({ kind: 'listing_version', publisherHandle: 'acme' })).toBe('publisher_fix_request');
    expect(fixes.remediationOwnership({ kind: 'listing_version', publisherHandle: 'pipeline-builder' })).toBe('official');
    expect(fixes.remediationOwnership({ kind: 'plugin', orgId: SYSTEM_ORG })).toBe('official');
    expect(fixes.remediationOwnership({ kind: 'plugin', orgId: 'org-acme' })).toBe('org');
  });

  it('sends its publisher the findings and the suggested patch (N40) and tells its installers — once per findings set', async () => {
    const { listing } = thirdParty();
    await fixes.sendPublisherFixRequest({ listingId: listing.id, version: '2.0.0', remaining: [remaining('CVE-2026-0100', { reason: 'third_party_listing' })], suggestedPatchKey: 'k/patch.diff' });

    const calls = h.notify.mock.calls.filter((c: any[]) => c[0] === 'N40');
    expect(calls).toHaveLength(2);
    const [, toPublisher, publisherContent, publisherOpts] = calls[0] as any[];
    expect(toPublisher).toEqual([{ kind: 'org_permission', orgId: 'org-acme', permission: 'publishers:manage' }]);
    expect(publisherContent.subject).toBe('Fix request: 1 vulnerability in acme/scan 2.0.0');
    expect(publisherContent.text).toContain('CVE-2026-0100 (critical) in golang.org/x/net 0.1.0 [go-module]: fixed in 0.17.0');
    expect(publisherContent.text).toContain('Suggested patch:\n--- a/Dockerfile');
    expect(publisherContent.text).toContain('never rebuilt');
    expect(publisherOpts).toEqual({ immediate: true });
    const [, toInstallers, installerContent] = calls[1] as any[];
    expect(toInstallers).toEqual([{ kind: 'org_permission', orgId: 'org-user', permission: 'plugin_installs:manage', inheritFromRoot: true }]);
    expect(installerContent.text).toContain('sent its publisher a fix request');
    expect(installerContent.text).not.toContain('Suggested patch');

    // The same findings again: deduplicated; a new finding: a new request.
    await fixes.sendPublisherFixRequest({ listingId: listing.id, version: '2.0.0', remaining: [remaining('CVE-2026-0100', { reason: 'third_party_listing' })], suggestedPatchKey: null });
    expect(h.notify.mock.calls.filter((c: any[]) => c[0] === 'N40')).toHaveLength(2);
    await fixes.sendPublisherFixRequest({ listingId: listing.id, version: '2.0.0', remaining: [remaining('CVE-2026-0101')], suggestedPatchKey: null });
    expect(h.notify.mock.calls.filter((c: any[]) => c[0] === 'N40')).toHaveLength(4);
  });

  it('still sends the request without an unreadable patch, and sends none for an Official listing or while remediation is off', async () => {
    const { listing, official } = thirdParty();
    fixes.setSuggestedPatchReaderForTests(async () => { throw new Error('NoSuchKey'); });
    await fixes.sendPublisherFixRequest({ listingId: listing.id, version: '2.0.0', remaining: [remaining('CVE-2026-0100')], suggestedPatchKey: 'gone' });
    expect(h.notify.mock.calls.filter((c: any[]) => c[0] === 'N40')).toHaveLength(2);
    expect((h.notify.mock.calls[0] as any[])[2].text).not.toContain('Suggested patch');

    const officialListing = db.seed('plugin_listings', { publisherId: official.id, name: 'lint', latestVersion: '1.0.0' });
    await fixes.sendPublisherFixRequest({ listingId: officialListing.id, version: '1.0.0', remaining: [remaining('CVE-2026-0102')], suggestedPatchKey: null });
    process.env.PLUGIN_REMEDIATION_ENABLED = 'false';
    await fixes.sendPublisherFixRequest({ listingId: listing.id, version: '2.0.0', remaining: [remaining('CVE-2026-0103')], suggestedPatchKey: null });
    expect(h.notify.mock.calls.filter((c: any[]) => c[0] === 'N40')).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// N36–N39
// -----------------------------------------------------------------------------

describe('remediation notices N36–N39', () => {
  const ORG = 'org-a';
  const base = { orgId: ORG, remediationId: '11111111-1111-4111-8111-111111111111', pluginName: 'lint', fromVersion: '1.4.2', toVersion: '1.4.3' };
  const summary = (status: 'done' | 'paused', over: Record<string, unknown> = {}) => ({
    status,
    toVersion: '1.4.3',
    waves: [],
    updatedAt: '2026-11-20T00:00:00.000Z',
    counts: { eligible: 9, proposed: 2, changeRequested: 1, moved: 5, failed: 0, rolledBack: 1, skippedOptOut: 1, skippedRunner: 0 },
    ...over,
  });

  it('N36 goes to the plugin security recipients, held for the org\'s digest, and names why a proposal waits', async () => {
    db.seed('plugin_security_notification_prefs', { orgId: ORG, digestMode: 'daily', notifyPipelineOwners: true });
    await notices.sendRemediationNotice({ ...base, code: 'N36', awaitingApproval: true, proposeReasons: ['org_mode', 'ask_agent_patch'], cleared: [cleared('CVE-1') as never], remaining: [], uploaderId: 'u-up' });
    const [event, recipients, content, opts] = h.notify.mock.calls[0] as any[];
    expect(event).toBe('N36');
    expect(recipients).toEqual([{ kind: 'org_permission', orgId: ORG, permission: 'plugins:write' }, { kind: 'org_members', orgId: ORG, userIds: ['u-up'] }]);
    expect(content.subject).toBe('Fix ready for approval: lint 1.4.3 clears 1 finding in lint@1.4.2');
    expect(content.text).toContain('drafted by the Ask agent');
    expect(content.text).toContain('- openssl 3.0.1 → 3.0.2 [rebuild]: CVE-1');
    expect(content.text).toContain('https://pb.example.com/dashboard/plugins?tab=remediations&remediation=11111111-1111-4111-8111-111111111111');
    expect(opts).toEqual({ deliverAfter: expect.any(Date), digestKey: `N36:${ORG}` });

    // The same stage again: nothing; once published: a second notice, published wording.
    await notices.sendRemediationNotice({ ...base, code: 'N36', awaitingApproval: true, cleared: [], remaining: [] });
    expect(h.notify).toHaveBeenCalledTimes(1);
    await notices.sendRemediationNotice({ ...base, code: 'N36', awaitingApproval: false, cleared: [cleared('CVE-1') as never], remaining: [] });
    expect((h.notify.mock.calls[1] as any[])[2].subject).toBe('Fix published: lint 1.4.3 clears 1 finding in lint@1.4.2');
  });

  it('N37 on done or paused only, to the recipients and the affected orgs\' pipeline writers (per their setting)', async () => {
    db.seed('plugin_security_notification_prefs', { orgId: 'org-off', notifyPipelineOwners: false, digestMode: 'immediate' });
    await notices.sendRemediationNotice({ ...base, code: 'N37', summary: summary('batches' as never) as never });
    expect(h.notify).not.toHaveBeenCalled();
    await notices.sendRemediationNotice({ ...base, code: 'N37', summary: summary('paused', { pausedReason: 'rollbacks' }) as never, affectedOrgIds: ['ORG-B', 'org-off'] });
    const calls = h.notify.mock.calls as any[];
    expect(calls).toHaveLength(2);
    expect(calls[0][2].subject).toBe('Rollout paused: lint 1.4.3');
    expect(calls[0][2].text).toContain('two pipelines were rolled back');
    expect(calls[0][2].text).toContain('5 moved, 2 offered the upgrade, 1 change requests');
    expect(calls[1][1]).toEqual([{ kind: 'org_permission', orgId: 'org-b', permission: 'pipelines:write' }]);
    // A redelivered report: nothing.
    await notices.sendRemediationNotice({ ...base, code: 'N37', summary: summary('paused', { pausedReason: 'rollbacks' }) as never, affectedOrgIds: ['org-b'] });
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('N38 goes to the pipeline\'s org pipeline writers at once, unless they opted out', async () => {
    await notices.sendRemediationNotice({ ...base, code: 'N38', pipelineOrgId: 'org-p', pipelineId: 'p-1', pipelineName: 'web', kind: 'rolled_back', rolledBackTo: '1.4.2', at: '2026-11-20T01:00:00Z' });
    const [event, recipients, content, opts] = h.notify.mock.calls[0] as any[];
    expect([event, recipients, opts]).toEqual(['N38', [{ kind: 'org_permission', orgId: 'org-p', permission: 'pipelines:write' }], { immediate: true }]);
    expect(content.subject).toBe('Pipeline "web" rolled back to lint 1.4.2');

    await notices.sendRemediationNotice({ ...base, code: 'N38', pipelineOrgId: 'org-p', pipelineId: 'p-2', kind: 'rollback_blocked', liveVersions: ['1.4.0', '1.4.3'], at: '2026-11-20T01:00:00Z' });
    expect((h.notify.mock.calls[1] as any[])[2].text).toContain('Live versions you can choose: 1.4.0, 1.4.3.');

    db.seed('plugin_security_notification_prefs', { orgId: 'org-q', notifyPipelineOwners: false });
    await notices.sendRemediationNotice({ ...base, code: 'N38', pipelineOrgId: 'org-q', pipelineId: 'p-3', kind: 'rolled_back', at: 'x' });
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('N39 lists each finding with package, CVE, fixed version, reason and required level — once per findings set', async () => {
    const left = [
      remaining('CVE-9', { reason: 'beyond_upgrade_level', requiredLevel: 'major', kev: true, packageName: 'lodash', packageType: 'npm', packageVersion: '3.10.1', fixedIn: ['4.17.21'], purl: 'pkg:npm/lodash@3.10.1' }),
      remaining('CVE-8', { reason: 'go_module_major', requiredLevel: 'owner' }),
      remaining('CVE-7', { reason: 'no_fix', fixedIn: [] }),
    ];
    await notices.sendRemediationNotice({ ...base, code: 'N39', toVersion: null, remaining: left as never });
    const [event, , content, opts] = h.notify.mock.calls[0] as any[];
    expect(event).toBe('N39');
    expect(opts).toEqual({ immediate: true });
    expect(content.subject).toBe('Remediation request: 3 findings in lint@1.4.2 need your fix');
    expect(content.text).toContain('(1 known exploited)');
    expect(content.text).toMatch(/- CVE-9 \(critical, known exploited\) in lodash 3\.10\.1 \[npm\]: fixed in 4\.17\.21\. Not fixed: .+; a fix needs a major upgrade\./);
    expect(content.text).toContain('a fix needs a new module path (owner change)');
    expect(content.text).toContain('- CVE-7 (critical) in golang.org/x/net 0.1.0 [go-module]: no fixed version yet.');
    await notices.sendRemediationNotice({ ...base, code: 'N39', remaining: left as never });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('sends nothing while the operator turned remediation off, and never throws on a relay failure', async () => {
    process.env.PLUGIN_REMEDIATION_ENABLED = 'false';
    await notices.sendRemediationNotice({ ...base, code: 'N39', remaining: [remaining('CVE-1')] });
    expect(h.notify).not.toHaveBeenCalled();
    delete process.env.PLUGIN_REMEDIATION_ENABLED;
    h.notify.mockRejectedValueOnce(new Error('relay down') as never);
    await expect(notices.sendRemediationNotice({ ...base, code: 'N39', remaining: [remaining('CVE-1')] })).resolves.toBeUndefined();
  });
});
