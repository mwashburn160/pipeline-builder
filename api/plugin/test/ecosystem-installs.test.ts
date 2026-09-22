// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Installs and the org consumption policy (plugin ecosystem §3.2, §3.4, §3.5,
 * §5a–§5c, D11, D13, D16, G33) against the in-memory database: installing and
 * requesting (approval policy by tier), pause and policy refusals, upgrades
 * across majors, uninstall and the implicit Official fallback, approve / deny
 * with N11 / N12 and audit, the policy read/write with team inheritance, the
 * in-app catalog, install state and shadowing, the lookup half of resolution
 * (with the signed tier annotation), and the installer fan-out (N8, N13, N14,
 * N26, N27) — publishers never learn who installed.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import {
  DIGEST_A, DIGEST_B, SYSTEM_ORG, moderator, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness,
} from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const installs = await import('../src/services/ecosystem/installs.js');
const installNotify = await import('../src/services/ecosystem/install-notify.js');
const store = await import('../src/services/ecosystem/installs-store.js');
const notify = await import('../src/services/ecosystem/notify.js');
const publishersSvc = await import('../src/services/ecosystem/publishers.js');
const consoleSvc = await import('../src/services/ecosystem/console.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const registry = await import('../src/services/ecosystem/registry.js');
await wireEcosystemHarness(h);

const { db } = h;
const registryGet = jest.fn(async (_path: string, _opts?: unknown): Promise<any> => ({ statusCode: 200, body: { data: { signed: true, tier: 'official', publisher: 'pipeline-builder' } } }));

beforeEach(() => {
  db.reset();
  h.notify.mockClear();
  h.audit.mockClear();
  h.registryPost.mockClear();
  registryGet.mockClear();
  registry.setRegistryClientForTests({ post: h.registryPost as any, get: registryGet as any });
});

const MEMBER = (over: Record<string, unknown> = {}) => tenant({ userId: 'u-member', orgId: 'org-b', name: 'bob', permissions: ['plugins:read', 'plugins:install'], ...over }) as any;
const ADMIN = (over: Record<string, unknown> = {}) => tenant({ userId: 'u-admin', orgId: 'org-b', name: 'ann', permissions: ['plugins:read', 'plugins:install', 'plugin_installs:manage'], ...over }) as any;

async function rejects(p: Promise<unknown>, code: string, reason?: string): Promise<any> {
  try {
    await p;
  } catch (err) {
    expect((err as { code: string }).code).toBe(code);
    if (reason) expect((err as { details?: { reason?: string } }).details?.reason).toBe(reason);
    return err;
  }
  throw new Error(`expected ${code}`);
}

function listing(publisher: { id: string; handle: string }, name: string, versions: Array<string | Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const l = db.seed('plugin_listings', { publisherId: publisher.id, name, summary: `${name} summary`, category: 'security', keywords: ['scan'], ...extra });
  const vs = versions.map((v) => {
    const over = typeof v === 'string' ? { version: v } : v;
    return db.seed('plugin_listing_versions', {
      listingId: l.id,
      imageDigest: DIGEST_A,
      imageRepository: `public/${publisher.handle}/${name}`,
      publishedBy: 'system',
      specSnapshot: { commands: [name], secrets: [{ name: 'TOKEN', required: true }], requiredMetadata: ['REGION'], primaryOutputDirectory: 'out', pluginType: 'CodeBuildStep' },
      changelog: `changes in ${(over as { version: string }).version}`,
      vulnCritical: 0,
      vulnHigh: 0,
      ...over,
    });
  });
  const latest = vs.map((v) => v.version as string).sort().pop();
  l.latestVersion = latest;
  return { listing: l, versions: vs };
}

function allowCommunity(orgId = 'org-b', over: Record<string, unknown> = {}) {
  db.seed('plugin_install_policies', { orgId, allowedTiers: ['official', 'verified', 'community'], ...over });
}

describe('createInstall', () => {
  it('installs a Verified listing directly (no approval below the policy line)', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    listing(acme, 'lint', ['1.0.0', '1.1.0', '2.0.0-rc.1']);
    const out = await installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' });
    expect(out.install).toMatchObject({ status: 'active', versionPolicy: 'minor', pinnedVersion: '1.1.0', resolvedVersion: '1.1.0', implicit: false, inherited: false });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.install.create', orgId: 'org-b', affectedOrgId: 'org-b', details: expect.objectContaining({ listing: 'acme/lint', version: '1.1.0', tier: 'verified' }),
    }));
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('refuses a tier the policy disallows (Community is off by default)', async () => {
    const { acme } = seedPublishers(db);
    listing(acme, 'lint', ['1.0.0']);
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' }), 'PLUGIN_BLOCKED_BY_POLICY', 'tier');
  });

  it('turns a member\'s Community install into a pending request (N11 to approvers); an approver installs directly', async () => {
    const { acme } = seedPublishers(db);
    listing(acme, 'lint', ['1.0.0']);
    allowCommunity();
    const out = await installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint', versionPolicy: 'pinned', version: '1.0.0' });
    expect(out.install).toMatchObject({ status: 'pending_approval', versionPolicy: 'pinned', resolvedVersion: null });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.install.request' }));
    expect(h.notify).toHaveBeenCalledWith('N11', [{ kind: 'org_permission', orgId: 'org-b', permission: 'plugin_installs:manage', inheritFromRoot: true }],
      expect.objectContaining({ subject: 'Install requested: acme/lint' }));
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' }), 'DUPLICATE_ENTRY');

    const admin = await installs.createInstall(ADMIN({ orgId: 'org-c' }), { publisher: 'acme', name: 'lint' }).catch((e) => e);
    expect(admin.code).toBe('PLUGIN_BLOCKED_BY_POLICY'); // org-c never allowed Community
    allowCommunity('org-c');
    const direct = await installs.createInstall(ADMIN({ orgId: 'org-c' }), { publisher: 'acme', name: 'lint' });
    expect(direct.install).toMatchObject({ status: 'active', approvedBy: 'u-admin' });
    await rejects(installs.createInstall(ADMIN({ orgId: 'org-c' }), { publisher: 'acme', name: 'lint' }), 'DUPLICATE_ENTRY');
  });

  it('refuses paused, blocked, suspended and unknown listings', async () => {
    const { official, acme } = seedPublishers(db, { tenantTier: 'verified' });
    listing(acme, 'paused', ['1.0.0'], { pausedAt: new Date() });
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'paused' }), 'PLUGIN_UNAVAILABLE', 'paused');
    listing(official, 'trivy', ['1.0.0']);
    db.seed('plugin_install_policies', { orgId: 'org-b', blockedListings: [{ publisher: 'pipeline-builder', name: 'trivy' }] });
    await rejects(installs.createInstall(MEMBER(), { publisher: 'pipeline-builder', name: 'trivy' }), 'PLUGIN_BLOCKED_BY_POLICY', 'blocked_listing');
    listing(acme, 'gone', ['1.0.0'], { state: 'suspended' });
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'gone' }), 'PLUGIN_UNAVAILABLE', 'suspended');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'nope' }), 'NOT_FOUND');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'Acme!', name: 'x' }), 'VALIDATION_ERROR');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'paused', versionPolicy: 'sometimes' }), 'VALIDATION_ERROR');
    await rejects(installs.createInstall(MEMBER({ permissions: ['plugins:read'] }), { publisher: 'acme', name: 'x' }), 'INSUFFICIENT_PERMISSIONS');
  });

  it('validates the baseline version: exact, published, not yanked / paused / advisory-blocked', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l } = listing(acme, 'lint', ['1.0.0', { version: '1.1.0', yankedAt: new Date() }, { version: '1.2.0', pausedAt: new Date() }, '1.3.0']);
    db.seed('plugin_advisories', { listingId: l.id, publisherId: acme.id, affectedRange: '1.3.0', severity: 'critical', summary: 'RCE', state: 'published', source: 'publisher', createdBy: 'u' });
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint', version: '^1' }), 'VALIDATION_ERROR');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint', version: '9.9.9' }), 'NOT_FOUND');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint', version: '1.1.0' }), 'PLUGIN_UNAVAILABLE', 'yanked');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint', version: '1.2.0' }), 'PLUGIN_UNAVAILABLE', 'paused');
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint', version: '1.3.0' }), 'PLUGIN_BLOCKED_BY_POLICY', 'advisory');
    // The default baseline skips all of them.
    expect((await installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' })).install.pinnedVersion).toBe('1.0.0');
  });

  it('refuses when no version is installable at all', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    listing(acme, 'lint', [{ version: '1.0.0', yankedAt: new Date() }]);
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' }), 'PLUGIN_UNAVAILABLE', 'no_version');
  });

  it('re-requests over a denied row, and maps a unique violation to DUPLICATE_ENTRY', async () => {
    const { acme } = seedPublishers(db);
    const { listing: l } = listing(acme, 'lint', ['1.0.0']);
    allowCommunity();
    db.seed('plugin_installs', { orgId: 'org-b', listingId: l.id, status: 'denied', installedBy: 'u-member', pinnedVersion: '1.0.0' });
    expect((await installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' })).install.status).toBe('pending_approval');
    db.tables.plugin_installs = [];
    db.failNextInsert('plugin_installs', Object.assign(new Error('dup'), { code: '23505' }));
    await rejects(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' }), 'DUPLICATE_ENTRY');
    db.failNextInsert('plugin_installs', new Error('db down'));
    await expect(installs.createInstall(MEMBER(), { publisher: 'acme', name: 'lint' })).rejects.toThrow('db down');
  });
});

describe('updateInstall / removeInstall', () => {
  async function installed(over: Record<string, unknown> = {}, tier = 'verified') {
    const { acme, official } = seedPublishers(db, { tenantTier: tier });
    const l = listing(acme, 'lint', ['1.0.0', '1.1.0', { version: '2.0.0', breaking: true }]);
    if (tier === 'community') allowCommunity();
    const row = db.seed('plugin_installs', { orgId: 'org-b', listingId: l.listing.id, status: 'active', installedBy: 'u-member', pinnedVersion: '1.0.0', versionPolicy: 'minor', ...over });
    return { acme, official, l, row };
  }

  it('upgrades across a major on a directly-installable tier and audits from → to', async () => {
    const { row } = await installed();
    const out = await installs.updateInstall(MEMBER(), row.id, { version: '2.0.0' });
    expect(out.install).toMatchObject({ pinnedVersion: '2.0.0', resolvedVersion: '2.0.0', upgrade: null });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.install.upgrade', details: { listing: 'acme/lint', from: { versionPolicy: 'minor', version: '1.0.0' }, to: { versionPolicy: 'minor', version: '2.0.0' } },
    }));
    // Changing only the policy keeps the baseline.
    expect((await installs.updateInstall(MEMBER(), row.id, { versionPolicy: 'patch' })).install).toMatchObject({ versionPolicy: 'patch', pinnedVersion: '2.0.0' });
  });

  it('needs an approver to cross a major (or widen to latest) on an approval-gated tier', async () => {
    const { row } = await installed({}, 'community');
    await rejects(installs.updateInstall(MEMBER(), row.id, { version: '2.0.0' }), 'INSUFFICIENT_PERMISSIONS');
    await rejects(installs.updateInstall(MEMBER(), row.id, { versionPolicy: 'latest' }), 'INSUFFICIENT_PERMISSIONS');
    expect((await installs.updateInstall(MEMBER(), row.id, { version: '1.1.0' })).install.pinnedVersion).toBe('1.1.0');
    expect((await installs.updateInstall(ADMIN(), row.id, { version: '2.0.0' })).install.pinnedVersion).toBe('2.0.0');
  });

  it('refuses other orgs\' rows (including a root org\'s, from a team), pending rows, and blocked listings', async () => {
    const { row, l } = await installed();
    await rejects(installs.updateInstall(MEMBER({ orgId: 'team-b', parentOrgId: 'org-b' }), row.id, {}), 'NOT_FOUND');
    await rejects(installs.updateInstall(MEMBER(), 'missing', {}), 'NOT_FOUND');
    row.status = 'pending_approval';
    await rejects(installs.updateInstall(MEMBER(), row.id, {}), 'CONFLICT');
    row.status = 'active';
    db.seed('plugin_install_policies', { orgId: 'org-b', blockedListings: [{ publisher: 'acme', name: 'lint' }] });
    await rejects(installs.updateInstall(MEMBER(), row.id, {}), 'PLUGIN_BLOCKED_BY_POLICY');
    l.listing.state = 'suspended';
    await rejects(installs.updateInstall(MEMBER(), row.id, {}), 'PLUGIN_UNAVAILABLE');
  });

  it('uninstalls (and withdraws a pending request), reporting the implicit Official fallback', async () => {
    const { row, official } = await installed();
    expect(await installs.removeInstall(MEMBER(), row.id)).toEqual({ removed: true, implicitFallback: false });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.install.remove', details: { listing: 'acme/lint', status: 'active' } }));
    const trivy = listing(official, 'trivy', ['1.0.0']);
    const pinned = db.seed('plugin_installs', { orgId: 'org-b', listingId: trivy.listing.id, status: 'pending_approval', installedBy: 'u-member', pinnedVersion: '1.0.0' });
    expect(await installs.removeInstall(MEMBER(), pinned.id)).toEqual({ removed: true, implicitFallback: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ withdrawn: true }) }));
    db.seed('plugin_install_policies', { orgId: 'org-b', officialInstalls: 'explicit' });
    const again = db.seed('plugin_installs', { orgId: 'org-b', listingId: trivy.listing.id, status: 'active', installedBy: 'u-member', pinnedVersion: '1.0.0' });
    expect(await installs.removeInstall(MEMBER(), again.id)).toEqual({ removed: true, implicitFallback: false });
    await rejects(installs.removeInstall(MEMBER(), again.id), 'NOT_FOUND');
  });
});

describe('approve / deny', () => {
  async function pending() {
    const { acme } = seedPublishers(db);
    const l = listing(acme, 'lint', ['1.0.0']);
    allowCommunity();
    const row = db.seed('plugin_installs', { orgId: 'org-b', listingId: l.listing.id, status: 'pending_approval', installedBy: 'u-member', pinnedVersion: '1.0.0' });
    return { row, l };
  }

  it('approves: active, audited, the requester is told (N12)', async () => {
    const { row } = await pending();
    const out = await installs.approveInstall(ADMIN(), row.id);
    expect(out.install).toMatchObject({ status: 'active', approvedBy: 'u-admin', resolvedVersion: '1.0.0' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.install.approve', details: expect.objectContaining({ requestedBy: 'u-member' }) }));
    expect(h.notify).toHaveBeenCalledWith('N12', [{ kind: 'user', userId: 'u-member', orgId: 'org-b' }], expect.objectContaining({ subject: 'Install approved: acme/lint' }));
    await rejects(installs.approveInstall(ADMIN(), row.id), 'CONFLICT');
  });

  it('denies with a reason; only approvers decide; a policy block wins at approval', async () => {
    const { row } = await pending();
    await rejects(installs.denyInstall(MEMBER(), row.id, 'no'), 'INSUFFICIENT_PERMISSIONS');
    const out = await installs.denyInstall(ADMIN(), row.id, '  not needed  ');
    expect(out.install.status).toBe('denied');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.install.deny', details: expect.objectContaining({ reason: 'not needed' }) }));
    expect(h.notify).toHaveBeenCalledWith('N12', expect.anything(), expect.objectContaining({ text: expect.stringMatching(/denied: not needed/) }));

    const again = await pending();
    db.tables.plugin_install_policies = [];
    await rejects(installs.approveInstall(ADMIN(), again.row.id), 'PLUGIN_BLOCKED_BY_POLICY', 'tier');
  });

  it('loses a race cleanly', async () => {
    const { row } = await pending();
    const transition = jest.spyOn(store.installRows, 'transition').mockResolvedValueOnce(null);
    await rejects(installs.denyInstall(ADMIN(), row.id, null), 'CONFLICT');
    transition.mockRestore();
  });
});

describe('consumption policy', () => {
  it('reads the defaults, then saves a validated update with an audit of what changed', async () => {
    expect(await installs.getPolicy(MEMBER())).toMatchObject({
      policy: { allowedTiers: ['official', 'verified'], officialInstalls: 'implicit' }, inheritsFromRoot: false, canEdit: false, updatedBy: null,
    });
    await rejects(installs.putPolicy(ADMIN(), { blockOnAdvisory: 'sometimes' }), 'VALIDATION_ERROR');
    await rejects(installs.putPolicy(MEMBER(), {}), 'INSUFFICIENT_PERMISSIONS');
    const out = await installs.putPolicy(ADMIN(), { allowedTiers: ['official'], blockedListings: ['acme/lint'] });
    expect(out).toMatchObject({ policy: { allowedTiers: ['official'], blockedListings: [{ publisher: 'acme', name: 'lint' }] }, canEdit: true, updatedBy: 'u-admin' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.plugin-install-policy.update',
      affectedOrgId: 'org-b',
      targetId: 'org-b',
      details: { changed: ['allowedTiers', 'blockedListings'], allowedTiers: { from: ['official', 'verified'], to: ['official'] }, blockedListings: 1 },
    }));
    await installs.putPolicy(ADMIN(), { blockOnAdvisory: 'high' });
    expect((await installs.getPolicy(ADMIN())).policy).toMatchObject({ allowedTiers: ['official'], blockOnAdvisory: 'high' });
  });

  it('a team inherits its root\'s policy and can only narrow it', async () => {
    db.seed('plugin_install_policies', { orgId: 'org-b', allowedTiers: ['official', 'verified', 'community'] });
    const team = ADMIN({ orgId: 'team-b', parentOrgId: 'org-b' });
    expect(await installs.getPolicy(team)).toMatchObject({ inheritsFromRoot: true, effective: { allowedTiers: ['official', 'verified', 'community'] } });
    await installs.putPolicy(team, { allowedTiers: ['official', 'community', 'unverified'], officialInstalls: 'explicit' });
    expect((await installs.getPolicy(team)).effective).toMatchObject({ allowedTiers: ['official', 'community'], officialInstalls: 'explicit' });
  });
});

describe('catalog, install state, installs list and shadowing', () => {
  function seedAll() {
    const { official, acme } = seedPublishers(db, { tenantTier: 'verified' });
    const trivy = listing(official, 'trivy', ['1.0.0', '1.1.0', { version: '2.0.0', breaking: true }]);
    const lint = listing(acme, 'lint', ['1.0.0'], { category: 'quality' });
    const semgrep = listing(official, 'semgrep', ['1.0.0']);
    db.seed('plugins', { orgId: 'org-b', name: 'semgrep', visibility: 'org', createdBy: 'u-x', deletedAt: null });
    db.seed('plugins', { orgId: 'org-b', name: 'trivy', visibility: 'private', createdBy: 'u-x', deletedAt: null });
    return { official, acme, trivy, lint, semgrep };
  }

  it('lists every live listing with the org\'s standing and the reference to write', async () => {
    seedAll();
    const { listings } = await installs.catalog(MEMBER(), {});
    expect(listings.map((e) => `${e.listing.publisherHandle}/${e.listing.name}`)).toEqual(['acme/lint', 'pipeline-builder/semgrep', 'pipeline-builder/trivy']);
    const [lint, semgrep, trivy] = listings;
    expect(lint).toMatchObject({ install: null, installable: true, requiresApproval: false, blocked: null, resolved: null, reference: { publisher: 'acme', name: 'lint' }, shadowedBy: null });
    expect(trivy).toMatchObject({
      install: { id: null, implicit: true, resolvedVersion: '1.1.0', upgrade: { version: '2.0.0', breaking: true, changelog: 'changes in 2.0.0' } },
      installable: true,
      reference: { name: 'trivy' },
      resolved: { version: '1.1.0', primaryOutputDirectory: 'out', requiredMetadata: ['REGION'], secrets: ['TOKEN'], pluginType: 'CodeBuildStep' },
      shadowedBy: null, // another member's private draft doesn't shadow for this caller
    });
    expect(semgrep).toMatchObject({ reference: { publisher: 'pipeline-builder', name: 'semgrep' }, shadowedBy: { pluginIds: [expect.any(String)] } });
    expect((await installs.catalog(MEMBER(), { q: 'LINT' })).listings).toHaveLength(1);
    expect((await installs.catalog(MEMBER(), { category: 'quality' })).listings).toHaveLength(1);
    expect((await installs.catalog(MEMBER(), { installed: 'true' })).listings.map((e) => e.listing.name)).toEqual(['semgrep', 'trivy']);
    expect((await installs.catalog(MEMBER(), { installed: 'false' })).listings.map((e) => e.listing.name)).toEqual(['lint']);
  });

  it('install state lists versions newest first and the caller\'s abilities', async () => {
    seedAll();
    const state = await installs.installState(MEMBER(), 'pipeline-builder', 'trivy');
    expect(state.versions.map((v) => v.version)).toEqual(['2.0.0', '1.1.0', '1.0.0']);
    expect(state).toMatchObject({ canInstall: true, canManage: false, entry: { install: { implicit: true } } });
    await rejects(installs.installState(MEMBER(), 'pipeline-builder', 'nothing'), 'NOT_FOUND');
    db.tables.plugin_listings.find((l) => l.name === 'semgrep')!.state = 'suspended';
    await rejects(installs.installState(MEMBER(), 'pipeline-builder', 'semgrep'), 'NOT_FOUND');
  });

  it('lists explicit installs, a root org\'s for a team (inherited), and the implicit ones on request', async () => {
    const { lint, trivy } = seedAll();
    db.seed('plugin_installs', { orgId: 'org-b', listingId: lint.listing.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-b', listingId: trivy.listing.id, status: 'pending_approval', installedBy: 'u', pinnedVersion: '2.0.0' });
    const own = await installs.listInstalls(MEMBER(), {});
    expect(own.installs.map((i) => [i.name, i.status, i.inherited])).toEqual([['lint', 'active', false], ['trivy', 'pending_approval', false]]);
    expect((await installs.listInstalls(MEMBER(), { status: 'active' })).installs.map((i) => i.name)).toEqual(['lint']);
    const team = await installs.listInstalls(MEMBER({ orgId: 'team-b', parentOrgId: 'org-b' }), {});
    expect(team.installs.map((i) => [i.name, i.inherited])).toEqual([['lint', true]]);
    const withImplicit = await installs.listInstalls(MEMBER({ orgId: 'org-z' }), { implicit: 'true' });
    expect(withImplicit.installs.map((i) => [i.name, i.implicit])).toEqual([['semgrep', true], ['trivy', true]]);
  });

  it('reports own plugins that shadow an Official listing', async () => {
    seedAll();
    expect((await installs.shadowing(MEMBER())).shadowing).toEqual([
      { name: 'semgrep', pluginIds: [expect.any(String)], listing: { publisherHandle: 'pipeline-builder', name: 'semgrep', publisherTier: 'official' } },
    ]);
    // The author of a private draft sees it shadow; a team sees only its parent's PUBLIC rows.
    expect((await installs.shadowing(MEMBER({ userId: 'u-x' }))).shadowing.map((s) => s.name)).toEqual(['semgrep', 'trivy']);
    expect((await installs.shadowing(MEMBER({ orgId: 'team-b', parentOrgId: 'org-b' }))).shadowing).toEqual([]);
  });
});

describe('lookup resolution (§3.5) and the signed tier annotation (§3.3)', () => {
  it('resolves the implicit Official install and refuses what the org can\'t use', async () => {
    const { official, acme } = seedPublishers(db, { tenantTier: 'verified' });
    listing(official, 'trivy', ['1.0.0', '1.1.0']);
    listing(acme, 'lint', ['1.0.0']);
    const res = await installs.resolveListedLookup({ orgId: 'org-b' }, { name: 'trivy' });
    expect(res && 'record' in res && res.record).toMatchObject({ name: 'trivy', version: '1.1.0', publisher: 'pipeline-builder', imageRepository: 'public/pipeline-builder/trivy', install: 'implicit' });
    expect(await installs.resolveListedLookup({ orgId: 'org-b' }, { name: 'missing' })).toBeNull();
    expect(await installs.resolveListedLookup({ orgId: 'org-b' }, { publisher: 'acme', name: 'lint' })).toEqual({
      refused: { status: 403, code: 'PLUGIN_NOT_INSTALLED', message: expect.stringMatching(/not installed/), details: { reason: 'not_installed' } },
    });
  });

  it('records what an own explicit install resolved to (only for an unversioned reference)', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l } = listing(acme, 'lint', ['1.0.0', '1.2.0']);
    const row = db.seed('plugin_installs', { orgId: 'org-b', listingId: l.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    await installs.resolveListedLookup({ orgId: 'org-b' }, { publisher: 'acme', name: 'lint', version: '1.0.0' });
    expect(row.resolvedVersion).toBeNull();
    await installs.resolveListedLookup({ orgId: 'org-b' }, { publisher: 'acme', name: 'lint' });
    expect(row.resolvedVersion).toBe('1.2.0');
    // A team's lookup never rewrites its root's row.
    row.resolvedVersion = null;
    await installs.resolveListedLookup({ orgId: 'team-b', rootOrgId: 'org-b' }, { publisher: 'acme', name: 'lint' });
    expect(row.resolvedVersion).toBeNull();
  });

  it('verifies the signature and the signed tier/publisher annotations', async () => {
    const { official } = seedPublishers(db);
    const { listing: l, versions } = listing(official, 'trivy', ['1.0.0']);
    const res = { publisher: db.tables.publishers[0] as any, listing: l as any, version: versions[0] as any };
    await expect(installs.verifyListedImage(res)).resolves.toBeUndefined();
    expect(registryGet).toHaveBeenCalledWith(`/internal/plugin-publications/verify?imageRepository=${encodeURIComponent('public/pipeline-builder/trivy')}&digest=${encodeURIComponent(DIGEST_A)}`, expect.anything());
    registryGet.mockResolvedValueOnce({ statusCode: 200, body: { data: { signed: true, tier: 'community', publisher: 'pipeline-builder' } } });
    await expect(installs.verifyListedImage(res)).rejects.toThrow(/signed as community\/pipeline-builder, not official\/pipeline-builder/);
    registryGet.mockResolvedValueOnce({ statusCode: 200, body: { data: { signed: false, tier: null, publisher: null } } });
    await expect(installs.verifyListedImage(res)).rejects.toThrow(/no valid platform signature/);
    registryGet.mockResolvedValueOnce({ statusCode: 400, body: { message: 'bad repo' } });
    await expect(installs.verifyListedImage(res)).rejects.toThrow(/could not be verified/);
    registryGet.mockResolvedValueOnce({ statusCode: 503, body: {} });
    await expect(installs.verifyListedImage(res)).rejects.toThrow(/HTTP 503/);
    registryGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(installs.verifyListedImage(res)).rejects.toThrow(/unreachable/);
    await expect(installs.verifyListedImage({ ...res, version: { ...res.version, imageDigest: null } })).rejects.toThrow(/no published image/);
  });

  it('shadowedListing names the Official listing an own plugin hides', async () => {
    const { official } = seedPublishers(db);
    listing(official, 'trivy', ['1.0.0']);
    expect(await installs.shadowedListing({ orgId: 'org-b' }, 'trivy')).toEqual({ publisher: 'pipeline-builder', name: 'trivy' });
    expect(await installs.shadowedListing({ orgId: 'org-b' }, 'other')).toBeNull();
  });
});

describe('installing-org fan-out (§5b: N8, N13, N14, N26, N27)', () => {
  const approvers = (orgId: string) => ({ kind: 'org_permission', orgId, permission: 'plugin_installs:manage', inheritFromRoot: true });

  it('finds explicit installers and implicit Official users (minus opt-outs and blocks)', async () => {
    const { official } = seedPublishers(db);
    const { listing: l } = listing(official, 'trivy', ['1.0.0', '2.0.0']);
    db.seed('plugin_installs', { orgId: 'org-pinned', listingId: l.id, status: 'active', installedBy: 'u', versionPolicy: 'pinned', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-pending', listingId: l.id, status: 'pending_approval', installedBy: 'u', pinnedVersion: '1.0.0' });
    db.seed('plugin_install_policies', { orgId: 'org-explicit', officialInstalls: 'explicit' });
    db.seed('plugin_install_policies', { orgId: 'org-blocked', blockedListings: [{ publisher: 'pipeline-builder', name: 'trivy' }] });
    let call = 0;
    db.execute.handler = () => (call++ === 0
      ? { rows: [{ org_id: 'ORG-USER', spec: null }, { org_id: 'org-explicit', spec: null }, { org_id: 'org-blocked', spec: null }, { org_id: 'org-v2', spec: '^2.0.0' }, { org_id: 'org-pending', spec: null }] }
      : [{ org_id: 'org-deployed' }]);
    const all = await installNotify.installingOrgs(official as any, l as any);
    expect(all.map((o) => [o.orgId, !!o.install])).toEqual([['org-deployed', false], ['org-pinned', true], ['org-user', false], ['org-v2', false]]);
    call = 0;
    const v2 = await installNotify.installingOrgs(official as any, l as any, '2.0.0');
    expect(v2.map((o) => o.orgId)).toEqual(['org-deployed', 'org-user', 'org-v2']);
  });

  it('announces a new version: N27 inside the range, N13 outside (immediate for a major)', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l, versions } = listing(acme, 'lint', ['1.0.0', { version: '1.1.0', vulnCritical: 2, changelog: 'Fixes' }, { version: '2.0.0', breaking: true }]);
    db.seed('plugin_installs', { orgId: 'org-minor', listingId: l.id, status: 'active', installedBy: 'u', versionPolicy: 'minor', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-pinned', listingId: l.id, status: 'active', installedBy: 'u', versionPolicy: 'pinned', pinnedVersion: '1.0.0' });
    const out = await installNotify.announceNewVersion(acme as any, l as any, versions[1] as any);
    expect(out).toEqual({ n13: 1, n27: 1 });
    expect(h.notify).toHaveBeenCalledWith('N27', [approvers('org-minor')], expect.objectContaining({
      subject: 'acme/lint updated to 1.1.0', text: expect.stringMatching(/Changelog:\nFixes[\s\S]*2 new critical/),
    }), {});
    expect(h.notify).toHaveBeenCalledWith('N13', [approvers('org-pinned')], expect.objectContaining({ subject: 'New version available: acme/lint 1.1.0' }), {});
    h.notify.mockClear();
    await installNotify.announceNewVersion(acme as any, l as any, versions[2] as any);
    expect(h.notify).toHaveBeenCalledWith('N13', expect.arrayContaining([approvers('org-minor')]),
      expect.objectContaining({ subject: 'New version available: acme/lint 2.0.0 (breaking)' }), { immediate: true });
  });

  it('announces to implicit Official users by the implicit range, and not at all without installers', async () => {
    const { official, acme } = seedPublishers(db);
    const { listing: l, versions } = listing(official, 'trivy', ['1.0.0', '1.1.0', '2.0.0']);
    db.execute.handler = () => ({ rows: [{ org_id: 'org-u', spec: null }] });
    await installNotify.announceNewVersion(official as any, l as any, versions[1] as any);
    expect(h.notify).toHaveBeenCalledWith('N27', [approvers('org-u')], expect.anything(), {});
    await installNotify.announceNewVersion(official as any, l as any, versions[2] as any);
    expect(h.notify).toHaveBeenCalledWith('N13', [approvers('org-u')], expect.anything(), { immediate: true });
    db.execute.handler = () => ({ rows: [] });
    const lone = listing(acme, 'solo', ['1.0.0']);
    expect(await installNotify.announceNewVersion(acme as any, lone.listing as any, lone.versions[0] as any)).toEqual({ n13: 0, n27: 0 });
  });

  it('never throws out of a notice: a failing send or lookup is counted', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l, versions } = listing(acme, 'lint', ['1.0.0']);
    db.seed('plugin_installs', { orgId: 'org-a1', listingId: l.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    h.notify.mockRejectedValueOnce(new Error('relay down'));
    expect(await installNotify.notifyListingPaused(acme as any, l as any)).toBe(0);
    const spy = jest.spyOn(store.installRows, 'forListing').mockRejectedValueOnce(new Error('db down'));
    expect(await installNotify.notifyListingUnmaintained(acme as any, l as any, 'abandoned')).toBe(0);
    spy.mockRejectedValueOnce(new Error('db down'));
    expect(await installNotify.announceNewVersion(acme as any, l as any, versions[0] as any)).toEqual({ n13: 0, n27: 0 });
    spy.mockRestore();
    expect(await installNotify.sendToOrgs('N14', [], { subject: 's', text: 't' })).toBe(0);
  });

  it('chunks recipients 50 per relay request', async () => {
    const orgs = Array.from({ length: 51 }, (_, i) => `org-${i}`);
    expect(await installNotify.sendToOrgs('N14', orgs, { subject: 's', text: 't' })).toBe(51);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('N26: pausing tells the installing orgs; N14: unmaintained tells them too', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l } = listing(acme, 'lint', ['1.0.0']);
    db.seed('plugin_installs', { orgId: 'org-a1', listingId: l.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    await publishersSvc.pause(tenant({ permissions: ['plugins:read', 'plugins:publish'] }) as any, l.id, undefined);
    expect(h.notify).toHaveBeenCalledWith('N26', [approvers('org-a1')], expect.objectContaining({ subject: 'Paused by its publisher: acme/lint' }), {});
    await publishersSvc.pause(tenant({ permissions: ['plugins:read', 'plugins:publish'] }) as any, l.id, '1.0.0');
    expect(h.notify).toHaveBeenCalledWith('N26', [approvers('org-a1')], expect.objectContaining({ subject: 'Paused by its publisher: acme/lint 1.0.0' }), {});
    await installNotify.notifyListingUnmaintained(acme as any, l as any, null);
    expect(h.notify).toHaveBeenCalledWith('N14', [approvers('org-a1')], expect.objectContaining({ subject: 'Plugin acme/lint is unmaintained' }), {});
  });

  it('a console state change notifies only THAT listing\'s installers; unmaintained adds N14', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l } = listing(acme, 'lint', ['1.0.0']);
    const other = listing(acme, 'fmt', ['1.0.0']);
    db.seed('plugin_installs', { orgId: 'org-a1', listingId: l.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-a2', listingId: other.listing.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    await consoleSvc.setListingState(moderator('mod-a') as any, l.id, { state: 'unmaintained', reason: 'no release in 12 months' });
    const recipients = h.notify.mock.calls.flatMap((c) => c[1] as Array<{ orgId?: string }>).map((r) => r.orgId).filter(Boolean);
    expect(recipients).toContain('org-a1');
    expect(recipients).not.toContain('org-a2');
    expect(h.notify).toHaveBeenCalledWith('N14', [approvers('org-a1')], expect.objectContaining({ subject: 'Plugin acme/lint is unmaintained' }), {});
  });

  it('N8 reaches the installing orgs (never the publisher\'s own org twice), per listing or publisher-wide', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing: l } = listing(acme, 'lint', ['1.0.0']);
    const other = listing(acme, 'fmt', ['1.0.0']);
    db.seed('plugin_installs', { orgId: 'org-a1', listingId: l.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-acme', listingId: l.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-a2', listingId: other.listing.id, status: 'active', installedBy: 'u', pinnedVersion: '1.0.0' });
    await notify.notifyModerationAction({ publisherOrgId: 'org-acme', subject: 'Yanked', text: 'x', listing: l as any, version: '1.0.0' });
    expect(h.notify).toHaveBeenCalledWith('N8', [{ kind: 'org_permission', orgId: 'org-acme', permission: 'publishers:manage' }], expect.anything(), {});
    expect(h.notify).toHaveBeenCalledWith('N8', [approvers('org-a1')], expect.objectContaining({ text: expect.stringMatching(/installed/) }), {});
    h.notify.mockClear();
    // A console action without a listing (publisher suspended): every listing's installers.
    await consoleSvc.suspendPublisher(moderator('mod-a') as any, acme.id, { reason: 'abuse' });
    expect(h.notify).toHaveBeenCalledWith('N8', [approvers('org-a1'), approvers('org-a2')], expect.anything(), {});
    h.notify.mockClear();
    await notify.notifyModerationAction({ publisherOrgId: null, subject: 's', text: 't' });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a yank reaches the installers whose install reaches that version', async () => {
    const { official } = seedPublishers(db);
    const { listing: l } = listing(official, 'trivy', ['1.0.0', '1.1.0']);
    db.seed('plugin_installs', { orgId: 'org-p1', listingId: l.id, status: 'active', installedBy: 'u', versionPolicy: 'pinned', pinnedVersion: '1.0.0' });
    db.seed('plugin_installs', { orgId: 'org-p2', listingId: l.id, status: 'active', installedBy: 'u', versionPolicy: 'pinned', pinnedVersion: '1.1.0' });
    await decisions.yankListedVersion(l as any, official as any, '1.1.0', 'CVE', SYSTEM_ORG);
    expect(h.notify).toHaveBeenCalledWith('N8', [approvers('org-p2')], expect.anything(), {});
  });
});

describe('store: implicit Official users and shadowing rows', () => {
  it('filters definitions by the version spec and keeps manifests', async () => {
    let call = 0;
    db.execute.handler = () => (call++ === 0 ? { rows: [{ org_id: 'a', spec: '^1.0.0' }, { org_id: 'b', spec: '2.0.0' }, { org_id: null, spec: null }] } : { rows: [{ org_id: 'c' }, { org_id: null }] });
    expect(await store.implicitOfficialUsers('trivy', '1.5.0')).toEqual(['a', 'c']);
    expect(db.execute.calls).toHaveLength(2);
  });

  it('returns nothing for no names', async () => {
    expect(await store.ownPluginsNamed([], { orgId: 'org-b' })).toEqual([]);
  });
});

void DIGEST_B;
