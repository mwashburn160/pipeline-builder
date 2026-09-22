// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system-org side of the plugin ecosystem (
 * ) against an in-memory database: deciding every request
 * kind, separation of duties and two-person approval (neither can be bypassed,
 * not even by a superadmin acting twice), the pinned digest failing closed,
 * the console's direct actions, auto-approval rule governance, the review
 * diff, the re-sign job and the plan-change upkeep.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  DIGEST_A, DIGEST_B, SYSTEM_ORG, loader, moderator, pluginRow, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness,
} from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const bootstrap = await import('../src/services/ecosystem/bootstrap.js');
const consoleSvc = await import('../src/services/ecosystem/console.js');
const resign = await import('../src/services/ecosystem/resign.js');
const maintenance = await import('../src/services/ecosystem/maintenance.js');
const registry = await import('../src/services/ecosystem/registry.js');
await wireEcosystemHarness(h);

const { db } = h;
const MOD_A = moderator('mod-a') as any;
const MOD_B = moderator('mod-b') as any;

async function rejects(p: Promise<unknown>, code: string): Promise<{ code: string; message: string; details?: any }> {
  try {
    await p;
  } catch (err) {
    expect((err as { code: string }).code).toBe(code);
    return err as { code: string; message: string };
  }
  throw new Error(`expected ${code}`);
}

function listed(publisher: { id: string }, name: string, version: string, extra: Record<string, unknown> = {}) {
  const listing = db.seed('plugin_listings', { publisherId: publisher.id, name, latestVersion: version, summary: 'S', ...extra });
  const v = db.seed('plugin_listing_versions', {
    listingId: listing.id,
    version,
    imageDigest: DIGEST_B,
    imageRepository: `public/acme/${name}`,
    publishedBy: 'system',
    specSnapshot: { dockerfile: 'FROM alpine:3.18', commands: ['lint'] },
    vulnCritical: 0,
    vulnHigh: 1,
  });
  return { listing, version: v };
}

async function submitNewListing(over: Record<string, unknown> = {}) {
  const plugin = db.seed('plugins', pluginRow(over));
  const out = await requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id });
  return { plugin, request: out.request };
}

beforeEach(() => {
  db.reset();
  h.setListingsLimit(-1);
  h.registryPost.mockClear();
  h.registryPost.mockImplementation(async (path: string, body: any) => ({
    statusCode: 200,
    body: { data: path.endsWith('/plugin-publications') ? { imageRepository: `public/${body.publisherHandle}/${body.name}`, digest: body.digest } : {} },
  }));
  h.membership.mockReset();
  h.membership.mockResolvedValue(false);
  h.notify.mockClear();
  h.audit.mockClear();
  h.quota.getTierStrict.mockResolvedValue('team');
});

afterEach(() => {
  delete process.env.OFFICIAL_AUTO_APPROVAL_ENABLED;
});

// -----------------------------------------------------------------------------
// Decisions
// -----------------------------------------------------------------------------

describe('approving a tenant new listing', () => {
  it('publishes the PINNED digest into public/*, records the listing + version, and tells the publisher (N25)', async () => {
    seedPublishers(db);
    const { plugin, request } = await submitNewListing();
    const out = await decisions.approve(MOD_A, request.id, 'looks good');
    expect(out.executed).toBe(true);
    expect(out.request).toMatchObject({ status: 'approved', decidedBy: 'mod-a', reason: 'looks good' });
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications', expect.objectContaining({
      sourceRepository: 'org-org-acme/lint', digest: DIGEST_A, tier: 'community', publisherHandle: 'acme', version: '1.0.0', publisherOrgId: 'org-acme',
    }), expect.anything());
    const listing = db.tables.plugin_listings![0]!;
    expect(listing).toMatchObject({ name: 'lint', latestVersion: '1.0.0', summary: 'Lints code.', category: 'quality', license: 'MIT' });
    expect(listing.readmeHtml).toContain('Lint');
    expect(db.tables.plugin_listing_versions![0]).toMatchObject({ sourcePluginId: plugin.id, imageRepository: 'public/acme/lint', imageDigest: DIGEST_A });
    expect(out.request.listingId).toBe(listing.id);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.listing.publish', orgId: SYSTEM_ORG, affectedOrgId: 'org-acme' }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.approve' }));
    expect(h.notify).toHaveBeenCalledWith('N25', [expect.objectContaining({ orgId: 'org-acme', permission: 'publishers:manage' })], expect.anything(), {});
    expect((await bootstrap.bootstrapState()).reason).toBe('first_reviewed_decision');
    await rejects(decisions.approve(MOD_A, request.id, null), 'CONFLICT');
  });

  it('fails closed when the digest moved after submit and rolls the request back', async () => {
    seedPublishers(db);
    const { plugin, request } = await submitNewListing();
    plugin.imageDigest = DIGEST_B;
    await rejects(decisions.approve(MOD_A, request.id, null), 'PLUGIN_DIGEST_MISMATCH');
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'pending', decidedBy: null });
    expect(db.tables.plugin_listings ?? []).toHaveLength(0);
    plugin.deletedAt = new Date();
    await rejects(decisions.approve(MOD_A, request.id, null), 'NOT_FOUND');
  });

  it('re-checks the listings quota at approval and records the refusal as a rejection', async () => {
    seedPublishers(db);
    const { request } = await submitNewListing();
    h.setListingsLimit(0);
    const err = await rejects(decisions.approve(MOD_A, request.id, null), 'QUOTA_EXCEEDED');
    expect(err.details).toMatchObject({ quotaType: 'listings', rejected: true });
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'rejected', reason: 'listings_quota' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.reject', details: expect.objectContaining({ reason: 'listings_quota' }) }));
  });

  it('refuses a listing name that got taken meanwhile', async () => {
    const { acme } = seedPublishers(db);
    const { request } = await submitNewListing();
    listed(acme, 'lint', '0.9.0');
    await rejects(decisions.approve(MOD_A, request.id, null), 'CONFLICT');
  });

  it('refuses to publish a version that is no longer public', async () => {
    seedPublishers(db);
    const { request } = await submitNewListing();
    db.tables.plugins![0]!.visibility = 'org';
    await rejects(decisions.approve(MOD_A, request.id, null), 'CONFLICT');
    expect(h.registryPost).not.toHaveBeenCalled();
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'pending' });
  });

  it('reuses an EMPTY listing shell of the same publisher instead of refusing', async () => {
    const { acme } = seedPublishers(db);
    const { request } = await submitNewListing();
    const shell = db.seed('plugin_listings', { publisherId: acme.id, name: 'lint' });
    await decisions.approve(MOD_A, request.id, null);
    expect(db.tables.plugin_listings).toHaveLength(1);
    expect(db.tables.plugin_listing_versions!.map((v) => v.listingId)).toEqual([shell.id]);
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'approved', listingId: shell.id });
  });

  it('a failed version write leaves NO listing behind — every write is one transaction', async () => {
    seedPublishers(db);
    const { request } = await submitNewListing();
    const writes: string[] = [];
    // Model the transaction: the fake's writes inside `atomically` are undone when it throws.
    db.failNextInsert('plugin_listing_versions', new Error('db write failed'));
    await expect(decisions.approve(MOD_A, request.id, null)).rejects.toThrow('db write failed');
    writes.push(...(db.tables.plugin_listings ?? []).map((l) => l.name));
    expect(writes).toEqual([]);
    // The request went back to pending (the approval rolled back), so a retry can publish.
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ status: 'pending', listingId: null });
  });
});

describe('separation of duties + two-person approval', () => {
  it('tenant orgs can never approve: the decision needs the system-org permission', async () => {
    seedPublishers(db);
    const { request } = await submitNewListing();
    await rejects(decisions.approve(tenant() as any, request.id, null), 'INSUFFICIENT_PERMISSIONS');
    await rejects(decisions.approve(moderator('mod-x', { permissions: ['publishers:verify'] }) as any, request.id, null), 'INSUFFICIENT_PERMISSIONS');
    await rejects(decisions.approve(MOD_A, 'missing', null), 'NOT_FOUND');
  });

  it('a manager who belongs to the requesting org (or whose membership can\'t be verified) can\'t decide', async () => {
    seedPublishers(db);
    const { request } = await submitNewListing();
    h.membership.mockResolvedValueOnce(true);
    await rejects(decisions.approve(MOD_A, request.id, null), 'SEPARATION_OF_DUTIES');
    h.membership.mockResolvedValueOnce(undefined);
    await rejects(decisions.reject(MOD_A, request.id, 'no'), 'SEPARATION_OF_DUTIES');
    h.membership.mockRejectedValueOnce(new Error('platform down'));
    await rejects(decisions.approve(MOD_A, request.id, null), 'SEPARATION_OF_DUTIES');
    const self = moderator('u-acme') as any;
    await rejects(decisions.approve(self, request.id, null), 'SEPARATION_OF_DUTIES');
  });

  it('an Official version needs two DIFFERENT managers — not the uploader, not the first approver, not a superadmin twice', async () => {
    const { official } = seedPublishers(db);
    listed(official, 'lint', '1.0.0');
    db.seed('ecosystem_settings', { key: 'bootstrap', value: { openedAt: null, closedAt: new Date().toISOString(), reason: 'x', approved: 0 } });
    const upload = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '2.0.0', createdBy: 'mod-a' }));
    const { requestId } = await requestsSvc.submitAfterBuild(loader() as any, upload.id);

    // The uploader can't approve their own Official version.
    await rejects(decisions.approve(MOD_A, requestId!, null), 'SEPARATION_OF_DUTIES');

    const superadmin = moderator('root', { isSuperAdmin: true, permissions: [] }) as any;
    const first = await decisions.approve(superadmin, requestId!, 'first');
    expect(first.executed).toBe(false);
    expect(first.request).toMatchObject({ status: 'pending_second_approval', firstApprovedBy: 'root' });
    expect(h.notify).toHaveBeenCalledWith('N28', [expect.objectContaining({ kind: 'moderators', excludeUserIds: ['root'] })], expect.anything(), {});
    expect(db.tables.plugin_listing_versions!.filter((v) => v.version === '2.0.0')).toHaveLength(0);

    // The same identity can't give the second approval — superadmin or not.
    await rejects(decisions.secondApprove(superadmin, requestId!, null), 'SEPARATION_OF_DUTIES');
    await rejects(decisions.approve(MOD_B, requestId!, null), 'CONFLICT');
    const second = await decisions.secondApprove(MOD_B, requestId!, 'second');
    expect(second.request).toMatchObject({ status: 'approved', secondApprovedBy: 'mod-b', decidedBy: 'mod-b' });
    expect(db.tables.plugin_listings![0]!.latestVersion).toBe('2.0.0');
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications', expect.objectContaining({ sourceRepository: 'system/lint', tier: 'official' }), expect.anything());
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.second-approve' }));
    await rejects(decisions.secondApprove(MOD_B, requestId!, null), 'CONFLICT');
  });

  it('rolls a failed second approval back to pending_second_approval', async () => {
    const { official } = seedPublishers(db);
    listed(official, 'lint', '1.0.0');
    const upload = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '2.0.0', createdBy: 'someone' }));
    db.seed('ecosystem_settings', { key: 'bootstrap', value: { openedAt: null, closedAt: new Date().toISOString(), reason: 'x', approved: 0 } });
    const { requestId } = await requestsSvc.submitAfterBuild(loader() as any, upload.id);
    await decisions.approve(MOD_A, requestId!, null);
    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 500, body: {} }));
    await expect(decisions.secondApprove(MOD_B, requestId!, null)).rejects.toThrow('image-registry refused');
    expect(db.tables.plugin_publish_requests!.find((r) => r.id === requestId)).toMatchObject({ status: 'pending_second_approval', secondApprovedBy: null });
  });
});

describe('rejecting', () => {
  it('rejects with a reason, releases the freeze and tells the publisher', async () => {
    seedPublishers(db);
    const { plugin, request } = await submitNewListing();
    const r = await decisions.reject(MOD_A, request.id, 'README is empty');
    expect(r).toMatchObject({ status: 'rejected', reason: 'README is empty', decidedBy: 'mod-a' });
    expect(plugin.frozenAt).toBeNull();
    expect(h.notify).toHaveBeenCalledWith('N25', expect.anything(), expect.objectContaining({ subject: expect.stringContaining('rejected') }), {});
    await rejects(decisions.reject(MOD_A, request.id, 'again'), 'CONFLICT');
  });

  it('rejects a Verified application (N7 + publisher.verify.reject) and a transfer (N10 to both orgs)', async () => {
    const { acme } = seedPublishers(db);
    const verify = await requestsSvc.submit(tenant({ features: ['verified_publisher'] }) as any, { kind: 'verify', application: {} });
    await decisions.reject(MOD_A, verify.request.id, 'domain not verified');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.verify.reject' }));
    expect(h.notify).toHaveBeenCalledWith('N7', expect.anything(), expect.anything(), {});

    db.seed('publishers', { handle: 'beta', ownerOrgId: 'org-beta', displayName: 'Beta' });
    const { listing } = listed(acme, 'lint', '1.0.0');
    const t = await requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: listing.id, target: { targetPublisherHandle: 'beta' } });
    await decisions.reject(MOD_A, t.request.id, 'no');
    expect(h.notify).toHaveBeenCalledWith('N10', [expect.objectContaining({ orgId: 'org-acme' }), expect.objectContaining({ orgId: 'org-beta' })], expect.anything(), {});
  });
});

describe('executing the other request kinds', () => {
  it('listing_update rewrites the listing columns (README rendered server-side)', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = listed(acme, 'lint', '1.0.0');
    const up = await requestsSvc.submit(tenant() as any, { kind: 'listing_update', listingId: listing.id, metadata: { summary: 'New', keywords: ['a'], readme: '# Hi <script>x</script>', icon: 'shield' } });
    await decisions.approve(MOD_A, up.request.id, null);
    expect(listing).toMatchObject({ summary: 'New', keywords: ['a'], icon: { key: 'shield' } });
    expect(listing.readmeHtml).not.toContain('<script>');
  });

  it('yank (step-up kind) yanks the version, drops the public tag, re-points latest and tells the publisher (N8)', async () => {
    const { acme } = seedPublishers(db);
    const { listing, version } = listed(acme, 'lint', '1.0.0');
    db.seed('plugin_listing_versions', { listingId: listing.id, version: '1.1.0', imageDigest: DIGEST_A, imageRepository: 'public/acme/lint', publishedBy: 'x' });
    listing.latestVersion = '1.1.0';
    const y = await requestsSvc.submit(tenant() as any, { kind: 'yank', listingId: listing.id, version: '1.1.0', reason: 'bad build' });
    await decisions.approve(MOD_A, y.request.id, null);
    expect(listing.latestVersion).toBe('1.0.0');
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/yank', { imageRepository: 'public/acme/lint', version: '1.1.0', digest: DIGEST_A }, expect.anything());
    expect(h.notify).toHaveBeenCalledWith('N8', expect.anything(), expect.anything(), {});
    expect(version.yankedAt).toBeNull();
  });

  it('unpause clears a listing or version pause', async () => {
    const { acme } = seedPublishers(db);
    const { listing, version } = listed(acme, 'lint', '1.0.0', { pausedAt: new Date() });
    version.pausedAt = new Date();
    const a = await requestsSvc.submit(tenant() as any, { kind: 'unpause', listingId: listing.id });
    const b = await requestsSvc.submit(tenant() as any, { kind: 'unpause', listingId: listing.id, version: '1.0.0' });
    await decisions.approve(MOD_A, a.request.id, null);
    await decisions.approve(MOD_A, b.request.id, null);
    expect(listing.pausedAt).toBeNull();
    expect(version.pausedAt).toBeNull();
  });

  it('transfer waits for the receiving org, then moves the listing and re-signs it', async () => {
    const { acme } = seedPublishers(db);
    const beta = db.seed('publishers', { handle: 'beta', ownerOrgId: 'org-beta', displayName: 'Beta', termsVersion: '2026-09-21' });
    const { listing } = listed(acme, 'lint', '1.0.0');
    const t = await requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: listing.id, target: { targetPublisherHandle: 'beta' } });
    await rejects(decisions.approve(MOD_A, t.request.id, null), 'CONFLICT');
    await requestsSvc.respondToTransfer(tenant({ orgId: 'org-beta', userId: 'u-beta' }) as any, t.request.id, true);
    await decisions.approve(MOD_A, t.request.id, null);
    expect(listing.publisherId).toBe(beta.id);
    expect((await resign.pendingResignJobs()).map((j) => j.scope)).toEqual(['listing']);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.transfer.approve' }));
  });

  it('claim (a reserved handle, or a community listing) and profile changes', async () => {
    const { acme } = seedPublishers(db);
    db.seed('ecosystem_reserved_names', { name: 'acme-official' });
    const c = await requestsSvc.submit(tenant() as any, { kind: 'claim', target: { handle: 'acme-official' } });
    await decisions.approve(MOD_A, c.request.id, null);
    expect(acme.handle).toBe('acme-official');

    const community = db.seed('publishers', { handle: 'community', ownerOrgId: null, displayName: 'Community', tier: 'unverified' });
    const orphan = db.seed('plugin_listings', { publisherId: community.id, name: 'orphan' });
    const l = await requestsSvc.submit(tenant() as any, { kind: 'claim', target: { listingId: orphan.id } });
    await decisions.approve(MOD_A, l.request.id, null);
    expect(orphan.publisherId).toBe(acme.id);

    const p = await requestsSvc.submit(tenant() as any, { kind: 'profile_change', target: { handle: 'acme-labs', displayName: 'Acme Labs' } });
    await decisions.approve(MOD_A, p.request.id, null);
    expect(acme).toMatchObject({ handle: 'acme-labs', displayName: 'Acme Labs' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.profile-change.approve' }));
  });

  it('a Verified application is two-person, then sets the tier, re-signs and tells the publisher (N7)', async () => {
    const { acme } = seedPublishers(db);
    const v = await requestsSvc.submit(tenant({ features: ['verified_publisher'] }) as any, { kind: 'verify', application: {} });
    expect((await decisions.approve(MOD_A, v.request.id, null)).executed).toBe(false);
    await decisions.secondApprove(MOD_B, v.request.id, null);
    expect(acme.tier).toBe('verified');
    expect(acme.verifiedAt).toBeInstanceOf(Date);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.tier.change', details: expect.objectContaining({ to: 'verified' }) }));
    expect(h.notify).toHaveBeenCalledWith('N7', expect.anything(), expect.anything(), {});
  });
});

// -----------------------------------------------------------------------------
// Console
// -----------------------------------------------------------------------------

describe('console queue + review diff', () => {
  it('lists the open queue oldest first with SLA, two-person and conflict flags', async () => {
    seedPublishers(db);
    await submitNewListing();
    await submitNewListing({ name: 'fmt' });
    db.tables.plugin_publish_requests![0]!.createdAt = new Date(Date.now() - 60_000);
    h.membership.mockResolvedValue(true);
    const { requests: items, total, nextCursor } = await consoleSvc.queue(MOD_A, {});
    expect(items.map((i) => i.listingName)).toEqual(['lint', 'fmt']);
    expect({ total, nextCursor }).toEqual({ total: 2, nextCursor: null });
    expect(items[0]).toMatchObject({ slaHours: 48, slaBreached: false, requiresTwoPerson: false, requiredPermission: 'plugins:moderate', conflictOfInterest: true });
    expect(await consoleSvc.queue(MOD_A, { status: 'decided', kind: 'new_listing', lane: 'standard', limit: '5' })).toEqual({ requests: [], total: 0, nextCursor: null });
    await rejects(consoleSvc.queue(MOD_A, { status: 'bogus' }), 'VALIDATION_ERROR');
  });

  it('pages the open queue OLDEST first in SQL — the oldest request is never cut off by the limit', async () => {
    seedPublishers(db);
    await submitNewListing();
    await submitNewListing({ name: 'fmt' });
    await submitNewListing({ name: 'vet' });
    const rows = db.tables.plugin_publish_requests!;
    rows.forEach((r, i) => { r.createdAt = new Date(Date.now() - (10 - i) * 60_000); });
    const page1 = await consoleSvc.queue(MOD_A, { limit: '1' });
    expect(page1.requests.map((i) => i.listingName)).toEqual(['lint']);
    expect(page1.total).toBe(3);
    const page2 = await consoleSvc.queue(MOD_A, { limit: '2', cursor: page1.nextCursor });
    expect(page2.requests.map((i) => i.listingName)).toEqual(['fmt', 'vet']);
    expect(page2.nextCursor).toBeNull();
    await rejects(consoleSvc.queue(MOD_A, { cursor: 'x' }), 'VALIDATION_ERROR');
  });

  it('shows the review diff: metadata provenance with user-edited links highlighted, contract/vuln/Dockerfile/SBOM deltas', async () => {
    const { acme } = seedPublishers(db);
    listed(acme, 'lint', '1.0.0', { homepageUrl: 'https://acme.dev' });
    const plugin = db.seed('plugins', pluginRow({ version: '1.1.0', networkEgress: ['api.acme.dev'], vulnHigh: 3, dockerfile: 'FROM alpine:3.19' }));
    const sub = await requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: plugin.id });
    const detail = await consoleSvc.requestDetail(MOD_A, sub.request.id);
    expect(detail.review.previousVersion).toBe('1.0.0');
    expect(detail.review.contract!.egress.added).toEqual(['api.acme.dev']);
    expect(detail.review.vuln).toMatchObject({ newHigh: 2, newCritical: 0 });
    expect(detail.review.dockerfile).toMatchObject({ previous: 'FROM alpine:3.18', current: 'FROM alpine:3.19', changed: true });
    expect(detail.review.sbom).toEqual({ added: ['openssl@3.0.1'], removed: ['openssl@3.0.0'], error: null });
    expect(detail.review.autoApproval.eligible).toBe(false);
    expect(detail.review.publisherHistory).toMatchObject({ tier: 'community', listings: 1 });

    const up = await requestsSvc.submit(tenant() as any, { kind: 'listing_update', listingId: db.tables.plugin_listings![0]!.id, metadata: { homepageUrl: 'https://evil.example' } });
    const upDetail = await consoleSvc.requestDetail(MOD_A, up.request.id);
    expect(upDetail.review.metadata).toEqual([expect.objectContaining({ field: 'homepageUrl', userEdited: true, isLink: true, highlight: true, previous: 'https://acme.dev' })]);
    expect(upDetail.review.contract).toBeNull();

    h.sbom.current.mockRejectedValueOnce(new Error('cosign failed'));
    expect((await consoleSvc.requestDetail(MOD_A, sub.request.id)).review.sbom!.error).toContain('cosign failed');
    await rejects(consoleSvc.requestDetail(MOD_A, 'missing'), 'NOT_FOUND');
  });

  it('reports the overview: pending counts, bootstrap state, flag, re-sign jobs', async () => {
    seedPublishers(db);
    await submitNewListing();
    const o = await consoleSvc.overview();
    expect(o).toMatchObject({ pending: { standard: 1, security: 0, secondApproval: 0, verify: 0 }, bootstrap: { state: 'never_opened' }, officialAutoApprovalEnabled: true, officialLoaderAccount: 'official-catalog-loader' });
  });
});

describe('console publisher actions', () => {
  it('suspends at once (re-sign at lowest trust, N8) and lifts a suspension only with two people', async () => {
    const { acme, official } = seedPublishers(db);
    const p = await consoleSvc.suspendPublisher(MOD_A, acme.id, { reason: 'malware' });
    expect(p.suspendedAt).not.toBeNull();
    expect(resign.trustFor(acme as any)).toBe('unverified');
    expect(h.notify).toHaveBeenCalledWith('N8', expect.anything(), expect.anything(), {});
    await rejects(consoleSvc.suspendPublisher(MOD_A, acme.id, { reason: 'x' }), 'CONFLICT');
    await rejects(consoleSvc.suspendPublisher(MOD_A, official.id, { reason: 'x' }), 'VALIDATION_ERROR');
    await rejects(consoleSvc.suspendPublisher(MOD_A, acme.id, {}), 'MISSING_REQUIRED_FIELD');

    const item = await consoleSvc.unsuspendPublisher(MOD_A, acme.id, { reason: 'cleaned' });
    expect(item).toMatchObject({ kind: 'moderation', status: 'pending_second_approval', conflictOfInterest: true });
    await rejects(consoleSvc.unsuspendPublisher(MOD_A, acme.id, {}), 'DUPLICATE_ENTRY');
    await rejects(decisions.secondApprove(MOD_A, item.id, null), 'SEPARATION_OF_DUTIES');
    await decisions.secondApprove(MOD_B, item.id, null);
    expect(acme.suspendedAt).toBeNull();
    await rejects(consoleSvc.unsuspendPublisher(MOD_A, acme.id, {}), 'CONFLICT');
  });

  it('decides lifting a suspension and granting Verified under publishers:verify — a moderate-only manager cannot give the second approval', async () => {
    const { acme } = seedPublishers(db);
    const MOD_ONLY = moderator('mod-c', { permissions: ['plugins:read', 'plugins:moderate'] }) as any;
    await consoleSvc.suspendPublisher(MOD_A, acme.id, { reason: 'malware' });
    const item = await consoleSvc.unsuspendPublisher(MOD_A, acme.id, { reason: 'cleaned' });
    expect(item.requiredPermission).toBe('publishers:verify');
    await rejects(decisions.secondApprove(MOD_ONLY, item.id, null), 'INSUFFICIENT_PERMISSIONS');
    expect(acme.suspendedAt).not.toBeNull();

    const up = await consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'verified', reason: 'known vendor' });
    await rejects(decisions.secondApprove(MOD_ONLY, (up as any).request.id, null), 'INSUFFICIENT_PERMISSIONS');
    expect(acme.tier).not.toBe('verified');
  });

  it('changes tier: to Verified is two-person, to Community is immediate', async () => {
    const { acme, official } = seedPublishers(db);
    const up = await consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'verified', reason: 'known vendor' });
    await decisions.secondApprove(MOD_B, (up as any).request.id, null);
    expect(acme.tier).toBe('verified');
    await rejects(consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'verified', reason: 'x' }), 'CONFLICT');
    const down = await consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'community', reason: 'lapsed' });
    expect((down as any).publisher.tier).toBe('community');
    await rejects(consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'community', reason: 'x' }), 'CONFLICT');
    await rejects(consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'gold', reason: 'x' }), 'VALIDATION_ERROR');
    await rejects(consoleSvc.setPublisherTier(MOD_A, official.id, { tier: 'community', reason: 'x' }), 'VALIDATION_ERROR');
    await rejects(consoleSvc.setPublisherTier(MOD_A, 'nope', { tier: 'community', reason: 'x' }), 'NOT_FOUND');
  });

  it('lists publishers with listing counts and filters', async () => {
    const { acme } = seedPublishers(db);
    listed(acme, 'lint', '1.0.0');
    const all = await consoleSvc.listPublishers({});
    expect(all.find((p) => p.handle === 'acme')!.listingCount).toBe(1);
    expect(await consoleSvc.listPublishers({ q: 'ACM', suspended: 'false', tier: 'community' })).toHaveLength(1);
    expect(await consoleSvc.listPublishers({ suspended: 'true' })).toHaveLength(0);
  });
});

describe('console listing actions', () => {
  it('marks unmaintained / suspended at once; relisting a suspended listing is two-person', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = listed(acme, 'lint', '1.0.0');
    expect((await consoleSvc.setListingState(MOD_A, listing.id, { state: 'unmaintained', reason: 'no release in 12 months' }) as any).listing.state).toBe('unmaintained');
    expect((await consoleSvc.setListingState(MOD_A, listing.id, { state: 'suspended', reason: 'policy' }) as any).listing.state).toBe('suspended');
    const relist = await consoleSvc.setListingState(MOD_A, listing.id, { state: 'listed', reason: 'fixed' }) as any;
    expect(relist.request.status).toBe('pending_second_approval');
    await decisions.secondApprove(MOD_B, relist.request.id, null);
    expect(listing.state).toBe('listed');
    await rejects(consoleSvc.setListingState(MOD_A, listing.id, { state: 'listed', reason: 'x' }), 'CONFLICT');
    await rejects(consoleSvc.setListingState(MOD_A, listing.id, { state: 'gone', reason: 'x' }), 'VALIDATION_ERROR');
    listing.state = 'transferred';
    await rejects(consoleSvc.setListingState(MOD_A, listing.id, { state: 'listed', reason: 'x' }), 'CONFLICT');
    await rejects(consoleSvc.setListingState(MOD_A, 'nope', { state: 'listed', reason: 'x' }), 'NOT_FOUND');
  });

  it('yanks at once and unyanks with two people, re-tagging from the listing version alone', async () => {
    const { official } = seedPublishers(db);
    const source = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, imageDigest: DIGEST_B }));
    const { listing, version } = listed(official, 'lint', '1.0.0');
    version.sourcePluginId = source.id;
    const after = await consoleSvc.yankVersion(MOD_A, listing.id, '1.0.0', { reason: 'CVE' });
    expect(after.versions![0]!.yankedAt).not.toBeNull();
    // Resolution reads listing versions: the org's source row is never touched.
    expect(source).toMatchObject({ yankedAt: null, frozenAt: null });
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/yank', { imageRepository: 'public/acme/lint', version: '1.0.0', digest: DIGEST_B }, expect.anything());
    await rejects(consoleSvc.yankVersion(MOD_A, listing.id, '1.0.0', { reason: 'x' }), 'CONFLICT');
    await rejects(consoleSvc.yankVersion(MOD_A, listing.id, '9.9.9', { reason: 'x' }), 'NOT_FOUND');

    // The source row may be gone by the time of the unyank — the re-tag doesn't need it.
    db.tables.plugins = [];
    const unyank = await consoleSvc.unyankVersion(MOD_A, listing.id, '1.0.0', { reason: 'false positive' });
    await decisions.secondApprove(MOD_B, unyank.id, null);
    expect(version.yankedAt).toBeNull();
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/retag', { imageRepository: 'public/acme/lint', version: '1.0.0', digest: DIGEST_B }, expect.anything());
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.version.unyank' }));
    await rejects(consoleSvc.unyankVersion(MOD_A, listing.id, '1.0.0', { reason: 'x' }), 'CONFLICT');
    await rejects(consoleSvc.unyankVersion(MOD_A, listing.id, '9.9.9', { reason: 'x' }), 'NOT_FOUND');
  });

  it('keeps the unyank when the re-tag fails (pinned digests still pull)', async () => {
    const { acme } = seedPublishers(db);
    const { listing, version } = listed(acme, 'fmt', '1.0.0', {});
    version.yankedAt = new Date();
    const unyank = await consoleSvc.unyankVersion(MOD_A, listing.id, '1.0.0', { reason: 'ok' });
    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 500, body: { message: 'down' } }));
    await decisions.secondApprove(MOD_B, unyank.id, null);
    expect(version.yankedAt).toBeNull();
  });

  it('lists listings with versions and filters', async () => {
    const { acme } = seedPublishers(db);
    listed(acme, 'lint', '1.0.0');
    listed(acme, 'fmt', '1.0.0');
    expect(await consoleSvc.listListings({ q: 'lin', state: 'listed', publisherId: acme.id })).toHaveLength(1);
  });
});

describe('auto-approval rule governance', () => {
  const conditions = { requestKinds: ['new_version'], publisherTiers: ['verified'], bumps: ['patch'] };

  it('creates a rule DISABLED with its enable pending; only a different manager can apply it', async () => {
    const rule = await consoleSvc.createRule(MOD_A, { name: 'Verified patches', conditions });
    expect(rule).toMatchObject({ enabled: false, pendingChange: expect.objectContaining({ requestedBy: 'mod-a', enabled: true }) });
    await rejects(consoleSvc.approveRuleChange(MOD_A, rule.id), 'SEPARATION_OF_DUTIES');
    const applied = await consoleSvc.approveRuleChange(MOD_B, rule.id);
    expect(applied).toMatchObject({ enabled: true, approvedBy: 'mod-b', pendingChange: null });
    await rejects(consoleSvc.approveRuleChange(MOD_B, rule.id), 'CONFLICT');
    expect((await consoleSvc.listRules())).toHaveLength(1);
  });

  it('narrows at once (disable, tighter caps) but parks a widening for a second manager', async () => {
    const rule = await consoleSvc.createRule(MOD_A, { name: 'R', conditions });
    await consoleSvc.approveRuleChange(MOD_B, rule.id);
    const off = await consoleSvc.updateRule(MOD_A, rule.id, { enabled: false });
    expect(off).toMatchObject({ enabled: false, pendingChange: null });
    const reEnable = await consoleSvc.updateRule(MOD_A, rule.id, { enabled: true });
    expect(reEnable.enabled).toBe(false);
    expect(reEnable.pendingChange).toMatchObject({ enabled: true });
    await consoleSvc.approveRuleChange(MOD_B, rule.id);
    const widened = await consoleSvc.updateRule(MOD_A, rule.id, { conditions: { ...conditions, bumps: ['patch', 'minor'] }, name: 'R2' });
    expect(widened).toMatchObject({ name: 'R2', conditions: { bumps: ['patch'] }, pendingChange: expect.objectContaining({ conditions: expect.objectContaining({ bumps: ['patch', 'minor'] }) }) });
    await rejects(consoleSvc.updateRule(MOD_A, rule.id, { conditions: { requestKinds: [] } }), 'VALIDATION_ERROR');
    await rejects(consoleSvc.createRule(MOD_A, { name: '', conditions }), 'VALIDATION_ERROR');
    await rejects(consoleSvc.updateRule(MOD_A, 'nope', {}), 'NOT_FOUND');
  });

  it('deletes a rule, detaching the requests it approved', async () => {
    const rule = await consoleSvc.createRule(MOD_A, { name: 'R', conditions });
    const { acme } = seedPublishers(db);
    db.seed('plugin_publish_requests', { publisherId: acme.id, kind: 'new_version', status: 'approved', autoRuleId: rule.id, decidedAt: new Date(), submittedBy: 'x' });
    expect(await consoleSvc.deleteRule(MOD_A, rule.id)).toEqual({ deleted: true });
    expect(db.tables.plugin_publish_requests![0]).toMatchObject({ autoRuleId: null, payload: { autoRuleName: 'R' } });
    await rejects(consoleSvc.deleteRule(MOD_A, rule.id), 'NOT_FOUND');
  });

  it('manages reserved names', async () => {
    const { acme } = seedPublishers(db);
    expect(await consoleSvc.putReserved(MOD_A, 'Trivy', { reason: 'Aqua', publisherId: acme.id })).toEqual({ name: 'trivy', reason: 'Aqua', publisherId: acme.id });
    expect(await consoleSvc.putReserved(MOD_A, 'trivy', {})).toMatchObject({ reason: null, publisherId: null });
    expect(await consoleSvc.listReserved()).toHaveLength(1);
    await rejects(consoleSvc.putReserved(MOD_A, 'Bad Name!', {}), 'VALIDATION_ERROR');
    await rejects(consoleSvc.putReserved(MOD_A, 'x', { publisherId: 'nope' }), 'NOT_FOUND');
    expect(await consoleSvc.deleteReserved(MOD_A, 'trivy')).toEqual({ deleted: true });
    await rejects(consoleSvc.deleteReserved(MOD_A, 'trivy'), 'NOT_FOUND');
  });
});

// -----------------------------------------------------------------------------
// Re-sign job + plan upkeep
// -----------------------------------------------------------------------------

describe('re-sign job', () => {
  it('keeps the PREVIOUS signature acceptable at lookup until the re-sign finishes, and kicks the run at once', async () => {
    const lookup = await import('../src/services/ecosystem/lookup.js');
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing, version } = listed(acme, 'lint', '1.0.0');
    let signed = { tier: 'verified', publisher: 'acme' };
    registry.setRegistryClientForTests({
      post: h.registryPost as any,
      delete: h.registryDelete as any,
      get: (async () => ({ statusCode: 200, body: { data: { signed: true, ...signed } } })) as any,
    });
    h.registryPost.mockImplementation(async (path: string, body: any) => {
      if (path.endsWith('/resign')) signed = { tier: body.tier, publisher: body.publisherHandle };
      return { statusCode: 200, body: { data: {} } };
    });
    try {
      h.resignKick.mockClear();
      await consoleSvc.setPublisherTier(MOD_A, acme.id, { tier: 'community', reason: 'policy breach' });
      expect(h.resignKick).toHaveBeenCalled();
      const res = () => ({ publisher: db.tables.publishers!.find((p) => p.id === acme.id) as any, listing: listing as any, version: version as any });
      // Still signed `verified`, the publisher is community now: the grace accepts it.
      await expect(lookup.verifyListedImage(res())).resolves.toBeUndefined();
      // A signature for someone else is still refused.
      signed = { tier: 'verified', publisher: 'mallory' };
      await expect(lookup.verifyListedImage(res())).rejects.toThrow(/must be re-signed/);
      signed = { tier: 'verified', publisher: 'acme' };
      expect(await resign.runResignJobs()).toMatchObject({ completed: 1 });
      expect(signed).toEqual({ tier: 'community', publisher: 'acme' });
      await expect(lookup.verifyListedImage(res())).resolves.toBeUndefined();
      // The job is gone, and with it the grace: the old signature no longer passes.
      signed = { tier: 'verified', publisher: 'acme' };
      await expect(lookup.verifyListedImage(res())).rejects.toThrow(/not community\/acme/);
    } finally {
      h.registryPost.mockReset().mockImplementation(async (path: string, body: any) => ({
        statusCode: 200,
        body: { data: path.endsWith('/plugin-publications') ? { imageRepository: `public/${body.publisherHandle}/${body.name}`, digest: body.digest } : {} },
      }));
      registry.setRegistryClientForTests({ post: h.registryPost as any, get: (async () => ({ statusCode: 200, body: {} })) as any, delete: h.registryDelete as any });
    }
  });

  it('a change landing MID-RUN is never lost: the stale runner neither deletes nor overwrites the newer job', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    listed(acme, 'lint', '1.0.0');
    await resign.enqueueResign('publisher', acme.id, 'tier_change', 'mod-a', { tier: 'community', handle: 'acme' });
    const before = (await resign.pendingResignJobs())[0]!;
    // While the runner is re-signing, a handle change re-queues the publisher.
    h.registryPost.mockImplementationOnce(async () => {
      await resign.enqueueResign('publisher', acme.id, 'handle_change', 'mod-b', { tier: 'verified', handle: 'acme-old' });
      return { statusCode: 200, body: {} };
    });
    expect(await resign.runResignJobs()).toMatchObject({ resigned: 1, completed: 0 });
    const [after] = await resign.pendingResignJobs();
    expect(after).toBeDefined();
    expect(after!.generation).not.toBe(before.generation);
    expect(after!.reason).toBe('handle_change');
    expect(after!.done).toEqual([]);
    // Grace APPENDS: both superseded signatures stay acceptable until the newer job finishes.
    expect(after!.previous).toEqual([{ tier: 'community', handle: 'acme' }, { tier: 'verified', handle: 'acme-old' }]);
    expect(await resign.runResignJobs()).toMatchObject({ completed: 1 });
    expect(await resign.pendingResignJobs()).toEqual([]);
  });

  it('re-signs every published image with the CURRENT annotations, resumes after a failure, then invalidates the verify cache', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    const { listing } = listed(acme, 'lint', '1.0.0');
    db.seed('plugin_listing_versions', { listingId: listing.id, version: '1.1.0', imageDigest: DIGEST_A, imageRepository: 'public/acme/lint', publishedBy: 'x' });
    db.seed('plugin_listing_versions', { listingId: listing.id, version: '0.1.0', publishedBy: 'x' }); // no image
    await resign.enqueueResign('publisher', acme.id, 'tier_change', 'mod-a');

    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 200, body: {} })).mockImplementationOnce(async () => ({ statusCode: 502, body: {} }));
    expect(await resign.runResignJobs()).toEqual({ resigned: 1, failed: 1, completed: 0 });
    expect((await resign.pendingResignJobs())[0]!.done).toHaveLength(1);

    expect(await resign.runResignJobs()).toEqual({ resigned: 1, failed: 0, completed: 1 });
    expect(await resign.pendingResignJobs()).toEqual([]);
    const resigns = h.registryPost.mock.calls.filter((c) => c[0] === '/internal/plugin-publications/resign');
    expect(resigns.at(-1)![1]).toMatchObject({ tier: 'verified', publisherHandle: 'acme', publisherOrgId: 'org-acme', progress: { completed: 2, total: 2 } });
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/verify-cache/invalidate', { imageRepository: 'public/acme/lint' }, expect.anything());
  });

  it('honours the per-pass budget and completes a job whose listing is gone', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = listed(acme, 'lint', '1.0.0');
    await resign.enqueueResign('listing', listing.id, 'transfer', 'mod-a');
    expect(await resign.runResignJobs(0)).toEqual({ resigned: 0, failed: 0, completed: 0 });
    await resign.enqueueResign('listing', 'gone', 'transfer', 'mod-a');
    const out = await resign.runResignJobs(1);
    expect(out.resigned).toBe(1);
  });

  it('queues a re-sign of every publisher with listings (key rotation)', async () => {
    const { acme, official } = seedPublishers(db);
    listed(acme, 'lint', '1.0.0');
    listed(official, 'fmt', '1.0.0');
    listed(acme, 'other', '1.0.0');
    expect(await consoleSvc.resignAll(MOD_A, { reason: 'plugin-signing key rotated' })).toEqual({ queued: 2 });
    expect((await resign.pendingResignJobs()).map((j) => j.reason)).toEqual(['operator', 'operator']);
    await rejects(consoleSvc.resignAll(MOD_A, {}), 'MISSING_REQUIRED_FIELD');
  });

  it('maps registry transport failures to RegistryPublicationError', async () => {
    h.registryPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(registry.invalidateVerifyCache()).rejects.toMatchObject({ name: 'RegistryPublicationError', status: 0 });
  });
});

describe('plan-change upkeep (N29)', () => {
  it('starts a Verified grace period on a downgrade, reminds at 14 and 3 days, and ends it with a re-sign', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    h.quota.getTierStrict.mockResolvedValue('pro');
    const now = new Date('2026-10-01T00:00:00Z');
    expect(await maintenance.checkVerifiedGrace(acme as any, now)).toBe('grace_started');
    expect(acme.verifiedGraceUntil).toEqual(new Date('2026-10-31T00:00:00Z'));
    expect(h.notify).toHaveBeenCalledWith('N29', expect.anything(), expect.objectContaining({ subject: expect.stringContaining('grace period started') }), {});
    expect(await maintenance.checkVerifiedGrace(acme as any, new Date('2026-10-05T00:00:00Z'))).toBe('in_grace');
    expect(await maintenance.checkVerifiedGrace(acme as any, new Date('2026-10-18T00:00:00Z'))).toBe('reminded');
    expect(await maintenance.checkVerifiedGrace(acme as any, new Date('2026-10-19T00:00:00Z'))).toBe('in_grace');
    expect(await maintenance.checkVerifiedGrace(acme as any, new Date('2026-10-29T00:00:00Z'))).toBe('reminded');
    expect(await maintenance.checkVerifiedGrace(acme as any, new Date('2026-11-01T00:00:00Z'))).toBe('downgraded');
    expect(acme.tier).toBe('community');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.tier.change', details: { from: 'verified', to: 'community', reason: 'plan_downgrade' } }));
    expect((await resign.pendingResignJobs())[0]).toMatchObject({ reason: 'plan_downgrade' });
  });

  it('keeps Verified when the plan is eligible again', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    expect(await maintenance.checkVerifiedGrace(acme as any)).toBe('eligible');
    acme.verifiedGraceUntil = new Date(Date.now() + 86_400_000);
    expect(await maintenance.checkVerifiedGrace(acme as any)).toBe('restored');
    expect(acme.verifiedGraceUntil).toBeNull();
  });

  it('tells a publisher once that it is over its listings limit, and clears the flag when it is back under', async () => {
    const { acme } = seedPublishers(db);
    listed(acme, 'a', '1.0.0');
    listed(acme, 'b', '1.0.0');
    h.setListingsLimit(1);
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('over');
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('already_over');
    h.setListingsLimit(5);
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('back_under');
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('ok');
  });

  it('never flags or clears the listings limit on an unreadable quota', async () => {
    const { acme } = seedPublishers(db);
    listed(acme, 'a', '1.0.0');
    listed(acme, 'b', '1.0.0');
    h.quota.check.mockResolvedValueOnce({ allowed: true, limit: -1, used: 0, remaining: -1, resetAt: '', unlimited: true, failOpen: true } as never);
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('skipped');
    h.setListingsLimit(1);
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('over');
    h.quota.check.mockResolvedValueOnce({ allowed: true, limit: -1, used: 0, remaining: -1, resetAt: '', unlimited: true, failOpen: true } as never);
    // Still flagged: an outage is not "back under".
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('skipped');
    expect(await maintenance.checkListingsLimit(acme as any)).toBe('already_over');
  });

  it('stops at the next checkpoint when the leader lease is lost', async () => {
    seedPublishers(db, { tenantTier: 'verified' });
    const lease = new AbortController();
    lease.abort();
    const out = await maintenance.runEcosystemMaintenance(new Date(), lease.signal);
    expect(out).toMatchObject({ resigned: 0, slaBreachesNotified: 0, submissionsExpired: 0 });
    expect(h.quota.getTierStrict).not.toHaveBeenCalled();
  });

  it('a failing re-sign pass is counted, and the rest of the pass still runs', async () => {
    // No tenant publishers: the first settings read is the re-sign job listing.
    db.failNextSelect('ecosystem_settings', new Error('db blip'));
    const out = await maintenance.runEcosystemMaintenance();
    expect(out).toMatchObject({ failures: 1, resigned: 0, submissionsExpired: 0, submitterEmailsPurged: 0 });
  });

  it('runs one maintenance pass over tenant publishers, counting failures', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    db.seed('publishers', { handle: 'gone', ownerOrgId: 'org-gone', displayName: 'Gone', suspendedAt: new Date() });
    // An unreadable tier (the fail-closed read's null) skips the publisher — no
    // grace period is started on a fallback tier.
    h.quota.getTierStrict.mockResolvedValueOnce(null);
    const out = await maintenance.runEcosystemMaintenance();
    expect(out).toMatchObject({ publishers: 1, failures: 1 });
    expect(acme.verifiedGraceUntil).toBeNull();
    expect(h.notify).not.toHaveBeenCalledWith('N29', expect.anything(), expect.anything(), expect.anything());
    expect(acme.id).toBeDefined();
    expect(maintenance.createEcosystemMaintenanceScheduler(() => ({}) as any)).toHaveProperty('start');
  });
});

describe('Official requests from the loader', () => {
  it('bootstrap does not apply once a person decided anything', async () => {
    seedPublishers(db);
    await bootstrap.closeBootstrap('first_reviewed_decision', 'mod-a');
    await bootstrap.closeBootstrap('again', 'mod-a');
    const up = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, up.id)).status).toBe('pending');
    expect((await bootstrap.bootstrapState()).reason).toBe('first_reviewed_decision');
    expect(DIGEST_A).toBeDefined();
  });
});
