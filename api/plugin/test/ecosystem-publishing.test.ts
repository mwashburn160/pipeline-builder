// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The tenant side of the plugin ecosystem (plan §3.1, §3.1a, §3.4, §3.7, W1)
 * against an in-memory database: publisher claim / profile / terms / pause,
 * submitting every request kind with its gates, the digest pin (G25), the
 * listings quota, withdraw and transfer responses, the post-build submit the
 * Official loader uses — and the automatic decisions: the one-time bootstrap
 * exception and the Official catalog auto-approval rule (§3.0.3).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  DIGEST_A, DIGEST_B, SYSTEM_ORG, loader, pluginRow, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness,
} from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const publishersSvc = await import('../src/services/ecosystem/publishers.js');
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
await wireEcosystemHarness(h);

const { db } = h;
const OFFICIAL_RULE = '00000000-0000-4000-8000-00000000a002';
const VERIFIED_RULE = '00000000-0000-4000-8000-00000000a001';

function seedRules(): void {
  db.seed('ecosystem_auto_approval_rules', {
    id: VERIFIED_RULE,
    name: 'Verified updates',
    enabled: true,
    createdBy: 'system',
    approvedBy: 'system',
    conditions: { seeded: 'verified_updates', requestKinds: ['new_version', 'listing_update'], publisherTiers: ['verified'], bumps: ['patch', 'minor'], textOnlyListingUpdates: true },
  });
  db.seed('ecosystem_auto_approval_rules', {
    id: OFFICIAL_RULE,
    name: 'Official catalog',
    enabled: true,
    createdBy: 'system',
    approvedBy: 'system',
    conditions: {
      seeded: 'official_catalog',
      requestKinds: ['new_version', 'listing_update'],
      publisherTiers: ['official'],
      bumps: ['patch', 'minor'],
      submitterServiceAccount: 'official-catalog-loader',
      textOnlyListingUpdates: true,
      maxPerListingPerDay: 1,
      maxPerDay: 50,
      instanceFlag: 'OFFICIAL_AUTO_APPROVAL_ENABLED',
    },
  });
}

async function rejects(p: Promise<unknown>, code: string): Promise<EcosystemErrorLike> {
  try {
    await p;
  } catch (err) {
    expect((err as EcosystemErrorLike).code).toBe(code);
    return err as EcosystemErrorLike;
  }
  throw new Error(`expected ${code}`);
}
type EcosystemErrorLike = { code: string; message: string; details?: Record<string, unknown> };

/** A listed version of `listingName` under `publisher` (bypassing the queue). */
function seedListed(publisher: { id: string }, name: string, version: string, extra: Record<string, unknown> = {}) {
  const listing = db.seed('plugin_listings', { publisherId: publisher.id, name, latestVersion: version, summary: 'Lints code.', description: 'Lints code.', category: 'quality', keywords: ['lint'], license: 'MIT', sourceUrl: 'https://github.com/acme/lint', readmeHtml: '<h1>Lint</h1>', ...extra });
  const v = db.seed('plugin_listing_versions', { listingId: listing.id, version, imageDigest: DIGEST_B, imageRepository: `public/x/${name}`, specSnapshot: {}, publishedBy: 'system', vulnCritical: 0, vulnHigh: 0 });
  return { listing, version: v };
}

beforeEach(() => {
  db.reset();
  h.setListingsLimit(-1);
  h.registryPost.mockClear();
  h.notify.mockClear();
  h.audit.mockClear();
});

afterEach(() => {
  delete process.env.PLUGIN_PUBLISHING_ENABLED;
  delete process.env.OFFICIAL_AUTO_APPROVAL_ENABLED;
  delete process.env.ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS;
});

// -----------------------------------------------------------------------------
// Publishers
// -----------------------------------------------------------------------------

describe('publisher profile (W1)', () => {
  it('claims a handle with the current terms, then reports its standing', async () => {
    const created = await publishersSvc.claimPublisher(tenant() as any, { handle: 'Acme', displayName: ' Acme Inc ', termsVersion: '2026-09-21', homepageUrl: 'https://acme.dev' });
    expect(created).toMatchObject({ handle: 'acme', displayName: 'Acme Inc', tier: 'community', termsVersion: '2026-09-21' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.create' }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.terms.accept' }));

    const state = await publishersSvc.publisherState(tenant({ features: ['verified_publisher'] }) as any);
    expect(state).toMatchObject({ isRootOrg: true, terms: { accepted: true }, verifiedEligible: true, listingsQuota: { used: 0, limit: -1 }, publishingEnabled: true });
    await rejects(publishersSvc.claimPublisher(tenant() as any, { handle: 'other', displayName: 'x', termsVersion: '2026-09-21' }), 'DUPLICATE_ENTRY');
  });

  it('refuses reserved, taken and malformed handles, stale terms and team orgs', async () => {
    seedPublishers(db);
    const other = tenant({ orgId: 'org-other' });
    await rejects(publishersSvc.claimPublisher(other as any, { handle: 'pipeline-builder', displayName: 'x', termsVersion: '2026-09-21' }), 'PUBLISHER_HANDLE_RESERVED');
    await rejects(publishersSvc.claimPublisher(other as any, { handle: 'acme', displayName: 'x', termsVersion: '2026-09-21' }), 'DUPLICATE_ENTRY');
    await rejects(publishersSvc.claimPublisher(other as any, { handle: '-bad', displayName: 'x', termsVersion: '2026-09-21' }), 'VALIDATION_ERROR');
    db.seed('ecosystem_reserved_names', { name: 'trivy', reason: 'vendor' });
    const reserved = await rejects(publishersSvc.claimPublisher(other as any, { handle: 'trivy', displayName: 'x', termsVersion: '2026-09-21' }), 'PUBLISHER_HANDLE_RESERVED');
    expect(reserved.message).toContain('claim request');
    await rejects(publishersSvc.claimPublisher(other as any, { handle: 'other', displayName: 'x', termsVersion: 'old' }), 'PUBLISHER_TERMS_REQUIRED');
    await rejects(publishersSvc.claimPublisher(other as any, { handle: 'other', displayName: '', termsVersion: '2026-09-21' }), 'VALIDATION_ERROR');
    await rejects(publishersSvc.claimPublisher(other as any, { handle: 'other', displayName: 'x', termsVersion: '2026-09-21', homepageUrl: 'http://insecure.io' }), 'VALIDATION_ERROR');
    await rejects(publishersSvc.claimPublisher(other as any, { handle: 'other', displayName: 'x', termsVersion: '2026-09-21', description: 5 }), 'VALIDATION_ERROR');
    await rejects(publishersSvc.claimPublisher(tenant({ orgId: 'team-1', parentOrgId: 'org-acme' }) as any, { handle: 'team', displayName: 'x', termsVersion: '2026-09-21' }), 'PUBLISHER_ROOT_ORG_REQUIRED');
  });

  it('edits description/homepage directly, refuses handle/name edits, and re-accepts terms', async () => {
    const { acme } = seedPublishers(db);
    const updated = await publishersSvc.updatePublisherProfile(tenant() as any, { description: ' New ', homepageUrl: null });
    expect(updated).toMatchObject({ description: 'New', homepageUrl: null });
    await rejects(publishersSvc.updatePublisherProfile(tenant() as any, { handle: 'x' }), 'VALIDATION_ERROR');
    await rejects(publishersSvc.updatePublisherProfile(tenant() as any, {}), 'VALIDATION_ERROR');
    await rejects(publishersSvc.updatePublisherProfile(tenant() as any, { description: 'x'.repeat(2001) }), 'VALIDATION_ERROR');
    await rejects(publishersSvc.updatePublisherProfile(tenant() as any, { homepageUrl: 5 }), 'VALIDATION_ERROR');

    acme.termsVersion = 'old';
    expect(publishersSvc.termsAccepted(acme as any)).toBe(false);
    await rejects(publishersSvc.acceptTerms(tenant() as any, 'old'), 'VALIDATION_ERROR');
    expect(await publishersSvc.acceptTerms(tenant() as any, '2026-09-21')).toMatchObject({ termsVersion: '2026-09-21' });
    await rejects(publishersSvc.acceptTerms(tenant({ orgId: 'nobody' }) as any, '2026-09-21'), 'PUBLISHER_REQUIRED');
  });

  it('lists its listings with versions and open requests, and pauses a listing or a version at once (D14)', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = seedListed(acme, 'lint', '1.0.0');
    db.seed('plugin_publish_requests', { publisherId: acme.id, listingId: listing.id, kind: 'yank', version: '1.0.0', submittedBy: 'u-acme' });

    const list = await publishersSvc.ownListings(tenant() as any);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'lint', openRequests: 1, versions: [expect.objectContaining({ version: '1.0.0' })] });
    expect(await publishersSvc.ownListings(tenant({ orgId: 'nobody' }) as any)).toEqual([]);

    const paused = await publishersSvc.pause(tenant() as any, listing.id, undefined);
    expect(paused.pausedAt).not.toBeNull();
    const vPaused = await publishersSvc.pause(tenant() as any, listing.id, '1.0.0');
    expect(vPaused.versions![0]!.pausedAt).not.toBeNull();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.version.pause' }));
    await rejects(publishersSvc.pause(tenant() as any, listing.id, '9.9.9'), 'NOT_FOUND');
    await rejects(publishersSvc.pause(tenant() as any, 'nope', undefined), 'NOT_FOUND');
    await rejects(publishersSvc.pause(tenant({ permissions: ['plugins:read'] }) as any, listing.id, undefined), 'INSUFFICIENT_PERMISSIONS');
  });

  it('keeps the Official publisher on this instance\'s system org', async () => {
    const created = await publishersSvc.ensureOfficialPublisher();
    expect(created).toMatchObject({ handle: 'pipeline-builder', tier: 'official', ownerOrgId: SYSTEM_ORG });
    created.ownerOrgId = 'wrong';
    db.tables.publishers![0]!.ownerOrgId = 'wrong';
    expect((await publishersSvc.ensureOfficialPublisher()).ownerOrgId).toBe(SYSTEM_ORG);
    expect((await publishersSvc.ensureOfficialPublisher()).ownerOrgId).toBe(SYSTEM_ORG);
  });

  it('reports a quota limit from the quota service for tenants', async () => {
    h.setListingsLimit(3);
    expect(await publishersSvc.listingsQuota('org-acme', null)).toEqual({ used: 0, limit: 3, failOpen: false });
    expect(await publishersSvc.listingsQuota(SYSTEM_ORG, null)).toEqual({ used: 0, limit: -1, failOpen: false });
  });

  it('flags an unreadable quota, and a DECISION refuses on it rather than approving past the limit (E4)', async () => {
    h.quota.check.mockResolvedValueOnce({ allowed: true, limit: -1, used: 0, remaining: -1, resetAt: '', unlimited: true, failOpen: true } as never);
    expect(await publishersSvc.listingsQuota('org-acme', null)).toMatchObject({ limit: -1, failOpen: true });
    h.quota.check.mockResolvedValueOnce({ allowed: true, limit: -1, used: 0, remaining: -1, resetAt: '', unlimited: true, failOpen: true } as never);
    await expect(publishersSvc.listingsQuotaOrThrow('org-acme', null)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

// -----------------------------------------------------------------------------
// Submitting requests
// -----------------------------------------------------------------------------

describe('new listing requests (§3.1, §3.1a, G25)', () => {
  it('drafts the accept-or-edit form: gates, detected metadata with provenance, quota', async () => {
    seedPublishers(db);
    const plugin = db.seed('plugins', pluginRow());
    const d = await requestsSvc.draft(tenant() as any, plugin.id);
    expect(d.kind).toBe('new_listing');
    expect(d.gates.every((g) => g.ok)).toBe(true);
    expect(d.metadata.find((m) => m.field === 'sourceUrl')).toMatchObject({ value: 'https://github.com/acme/lint', source: 'dockerfile' });
    expect(d.listingUpdateOffer).toEqual([]);
    await rejects(requestsSvc.draft(tenant() as any, 'missing'), 'NOT_FOUND');
    await rejects(requestsSvc.draft(tenant() as any, undefined), 'MISSING_REQUIRED_FIELD');
  });

  it('submits with edits (provenance user), pins the digest, freezes the version and notifies moderators', async () => {
    const { acme } = seedPublishers(db);
    const plugin = db.seed('plugins', pluginRow());
    const out = await requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id, metadata: { summary: 'Fast linting', homepageUrl: 'https://acme.dev/lint' } });
    expect(out.autoApproved).toBe(false);
    expect(out.request).toMatchObject({ kind: 'new_listing', status: 'pending', digest: DIGEST_A, version: '1.0.0', publisherHandle: 'acme', listingName: 'lint' });
    const meta = (out.request.payload as any).metadata;
    expect(meta.values.summary).toBe('Fast linting');
    expect(meta.sources.summary).toBe('user');
    expect(meta.sources.homepageUrl).toBe('user');
    expect(meta.sources.description).toBe('spec');
    expect(plugin.frozenAt).toBeInstanceOf(Date);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.submit', details: expect.objectContaining({ kind: 'new_listing', digest: DIGEST_A }) }));
    expect(h.notify).toHaveBeenCalledWith('N24', [expect.objectContaining({ kind: 'moderators', permission: 'plugins:moderate', excludeMembersOfOrgId: 'org-acme' })], expect.anything(), {});

    // One open request per (publisher, kind, name, version).
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id }), 'DUPLICATE_ENTRY');
    expect(acme.id).toBeDefined();
  });

  it('refuses a failing gate with the gate list, contract keys in metadata, and a reserved listing name', async () => {
    seedPublishers(db);
    const bad = db.seed('plugins', pluginRow({ visibility: 'org', license: null }));
    const err = await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: bad.id }), 'PUBLISH_GATE_FAILED');
    expect((err.details!.gates as Array<{ id: string }>).map((g) => g.id)).toEqual(['visibility', 'license']);

    const ok = db.seed('plugins', pluginRow({ name: 'fmt' }));
    const contract = await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: ok.id, metadata: { commands: ['rm -rf /'] } }), 'VALIDATION_ERROR');
    expect(contract.details).toEqual({ contractKeys: ['commands'] });

    db.seed('ecosystem_reserved_names', { name: 'trivy' });
    const trivy = db.seed('plugins', pluginRow({ name: 'trivy' }));
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: trivy.id }), 'PUBLISH_GATE_FAILED');
  });

  it('enforces the listings quota at submit, counting pending new listings (§3.7)', async () => {
    seedPublishers(db);
    h.setListingsLimit(1);
    const a = db.seed('plugins', pluginRow({ name: 'a' }));
    const b = db.seed('plugins', pluginRow({ name: 'b' }));
    await requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: a.id });
    const err = await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: b.id }), 'QUOTA_EXCEEDED');
    expect(err.details).toMatchObject({ quotaType: 'listings', limit: 1 });
  });

  it('refuses without a publisher, with stale terms, when suspended, when disabled, without the permission, from a team', async () => {
    const plugin = db.seed('plugins', pluginRow());
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id }), 'PUBLISHER_REQUIRED');
    const { acme } = seedPublishers(db);
    acme.termsVersion = 'old';
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id }), 'PUBLISHER_TERMS_REQUIRED');
    acme.termsVersion = '2026-09-21';
    acme.suspendedAt = new Date();
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id }), 'PUBLISHER_SUSPENDED');
    acme.suspendedAt = null;
    process.env.PLUGIN_PUBLISHING_ENABLED = 'false';
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id }), 'PLUGIN_PUBLISHING_DISABLED');
    delete process.env.PLUGIN_PUBLISHING_ENABLED;
    await rejects(requestsSvc.submit(tenant({ permissions: ['publishers:manage'] }) as any, { kind: 'new_listing', pluginId: plugin.id }), 'INSUFFICIENT_PERMISSIONS');
    await rejects(requestsSvc.submit(tenant({ permissions: ['plugins:publish'] }) as any, { kind: 'verify' }), 'INSUFFICIENT_PERMISSIONS');
    await rejects(requestsSvc.submit(tenant({ parentOrgId: 'org-root' }) as any, { kind: 'new_listing', pluginId: plugin.id }), 'PUBLISHER_ROOT_ORG_REQUIRED');
    // `moderation` requests are system-org-created only.
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'moderation' }), 'VALIDATION_ERROR');
  });

  it('releases the freeze when the insert fails, and maps a unique violation to DUPLICATE_ENTRY', async () => {
    seedPublishers(db);
    const plugin = db.seed('plugins', pluginRow());
    db.failNextInsert('plugin_publish_requests', Object.assign(new Error('dup'), { code: '23505' }));
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id }), 'DUPLICATE_ENTRY');
    expect(plugin.frozenAt).toBeNull();
    db.failNextInsert('plugin_publish_requests', new Error('db down'));
    await expect(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id })).rejects.toThrow('db down');
  });
});

describe('version, update, yank, unpause requests', () => {
  it('drafts a new version next to the live listing with a changed-fields offer', async () => {
    const { acme } = seedPublishers(db);
    seedListed(acme, 'lint', '1.0.0', { summary: 'Old summary' });
    const plugin = db.seed('plugins', pluginRow({ version: '1.1.0' }));
    const d = await requestsSvc.draft(tenant() as any, plugin.id);
    expect(d.kind).toBe('new_version');
    expect(d.listingUpdateOffer).toEqual([{ field: 'summary', value: 'Lints code.', current: 'Old summary' }]);
    expect(d.metadata.find((m) => m.field === 'summary')).toMatchObject({ changed: true, current: 'Old summary' });
  });

  it('submits a new version (breaking on a major), refuses wrong kinds and already-published versions', async () => {
    const { acme } = seedPublishers(db);
    seedListed(acme, 'lint', '1.0.0');
    const next = db.seed('plugins', pluginRow({ version: '2.0.0' }));
    const out = await requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: next.id });
    expect((out.request.payload as any).breaking).toBe(true);
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: next.id }), 'CONFLICT');
    const same = db.seed('plugins', pluginRow({ version: '1.0.0', name: 'lint', imageDigest: DIGEST_B }));
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: same.id }), 'PUBLISH_GATE_FAILED');
    const unlisted = db.seed('plugins', pluginRow({ name: 'fresh' }));
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: unlisted.id }), 'CONFLICT');
  });

  it('freezes new versions over the listings limit except in the security-fix lane (§3.7)', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = seedListed(acme, 'lint', '1.0.0');
    seedListed(acme, 'fmt', '1.0.0');
    h.setListingsLimit(1);
    const next = db.seed('plugins', pluginRow({ version: '1.0.1' }));
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: next.id }), 'QUOTA_EXCEEDED');
    const advisory = db.seed('plugin_advisories', { listingId: listing.id, publisherId: acme.id, state: 'published' });
    const out = await requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: next.id, securityFixAdvisoryId: advisory.id });
    expect(out.request.lane).toBe('security');
    expect(h.notify).toHaveBeenCalledWith('N24', expect.anything(), expect.anything(), { immediate: true, mandatory: true });
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: next.id, securityFixAdvisoryId: 'nope' }), 'VALIDATION_ERROR');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: next.id, securityFixAdvisoryId: 5 }), 'VALIDATION_ERROR');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'listing_update', listingId: listing.id, metadata: { summary: 'x' } }), 'QUOTA_EXCEEDED');
  });

  it('submits a changed-fields listing update with sources, refusing no-op and non-live listings', async () => {
    const { acme } = seedPublishers(db);
    const { listing } = seedListed(acme, 'lint', '1.0.0');
    const out = await requestsSvc.submit(tenant() as any, {
      kind: 'listing_update', listingId: listing.id, metadata: { summary: 'Better', description: 'Lints code.' }, sources: { summary: 'spec', bogus: 'x' },
    });
    expect((out.request.payload as any).metadata).toEqual({ values: { summary: 'Better' }, sources: { summary: 'spec' } });
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'listing_update', listingId: listing.id, metadata: { description: 'Lints code.' } }), 'VALIDATION_ERROR');
    listing.state = 'suspended';
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'listing_update', listingId: listing.id, metadata: { summary: 'x' } }), 'CONFLICT');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'listing_update', listingId: 'nope', metadata: {} }), 'NOT_FOUND');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'listing_update' }), 'MISSING_REQUIRED_FIELD');
  });

  it('requests a yank (reason required) and an unpause (must be paused)', async () => {
    const { acme } = seedPublishers(db);
    const { listing, version } = seedListed(acme, 'lint', '1.0.0');
    const yank = await requestsSvc.submit(tenant() as any, { kind: 'yank', listingId: listing.id, version: '1.0.0', reason: 'broken' });
    expect(yank.request).toMatchObject({ kind: 'yank', version: '1.0.0', digest: DIGEST_B, reason: 'broken' });
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'yank', listingId: listing.id, version: '9.0.0', reason: 'x' }), 'NOT_FOUND');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'yank', listingId: listing.id, version: '1.0.0' }), 'MISSING_REQUIRED_FIELD');
    version.yankedAt = new Date();
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'yank', listingId: listing.id, version: '1.0.0', reason: 'x' }), 'CONFLICT');

    await rejects(requestsSvc.submit(tenant() as any, { kind: 'unpause', listingId: listing.id }), 'CONFLICT');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'unpause', listingId: listing.id, version: '1.0.0' }), 'CONFLICT');
    listing.pausedAt = new Date();
    version.pausedAt = new Date();
    expect((await requestsSvc.submit(tenant() as any, { kind: 'unpause', listingId: listing.id })).request.kind).toBe('unpause');
    expect((await requestsSvc.submit(tenant() as any, { kind: 'unpause', listingId: listing.id, version: '1.0.0' })).request.version).toBe('1.0.0');
  });
});

describe('publisher-level requests: transfer, claim, profile change, Verified', () => {
  it('offers a transfer to another publisher, who accepts or declines it (N9, N10)', async () => {
    const { acme } = seedPublishers(db);
    const beta = db.seed('publishers', { handle: 'beta', ownerOrgId: 'org-beta', displayName: 'Beta', termsVersion: '2026-09-21' });
    const { listing } = seedListed(acme, 'lint', '1.0.0');
    const out = await requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: listing.id, target: { targetPublisherHandle: 'Beta' } });
    expect((out.request.payload as any).transfer).toMatchObject({ targetPublisherId: beta.id, targetOrgId: 'org-beta', response: 'pending' });
    expect(h.notify).toHaveBeenCalledWith('N9', [expect.objectContaining({ orgId: 'org-beta' })], expect.anything(), {});
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.transfer.request', affectedOrgId: 'org-beta' }));

    const betaCaller = tenant({ userId: 'u-beta', orgId: 'org-beta' });
    expect((await requestsSvc.incomingTransfers(betaCaller as any)).requests).toHaveLength(1);
    // Filtered in SQL: another publisher's transfer never reaches beta's page.
    expect((await requestsSvc.incomingTransfers(tenant() as any)).requests).toEqual([]);
    expect(await requestsSvc.incomingTransfers(tenant({ orgId: 'none' }) as any)).toEqual({ requests: [], nextCursor: null });
    const accepted = await requestsSvc.respondToTransfer(betaCaller as any, out.request.id, true);
    expect((accepted.payload as any).transfer.response).toBe('accepted');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.transfer.accept' }));
    await rejects(requestsSvc.respondToTransfer(betaCaller as any, out.request.id, true), 'CONFLICT');
    await rejects(requestsSvc.respondToTransfer(tenant() as any, out.request.id, true), 'NOT_FOUND');

    // A second offer, declined, ends the transfer.
    const second = db.seed('plugin_listings', { publisherId: acme.id, name: 'fmt' });
    const again = await requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: second.id, target: { targetPublisherHandle: 'beta' } });
    const declined = await requestsSvc.respondToTransfer(betaCaller as any, again.request.id, false);
    expect(declined.status).toBe('rejected');

    await rejects(requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: listing.id, target: { targetPublisherHandle: 'acme' } }), 'NOT_FOUND');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: listing.id, target: { targetPublisherHandle: 'pipeline-builder' } }), 'VALIDATION_ERROR');
    beta.suspendedAt = new Date();
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'transfer', listingId: listing.id, target: { targetPublisherHandle: 'beta' } }), 'CONFLICT');
  });

  it('claims a RESERVED handle or a community listing, and refuses anything else', async () => {
    seedPublishers(db);
    db.seed('ecosystem_reserved_names', { name: 'trivy', reason: 'Aqua' });
    const handle = await requestsSvc.submit(tenant() as any, { kind: 'claim', target: { handle: 'Trivy' } });
    expect((handle.request.payload as any).target).toEqual({ handle: 'trivy' });
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'claim', target: { handle: 'free-name' } }), 'VALIDATION_ERROR');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'claim', target: { handle: 'x' } }), 'VALIDATION_ERROR');

    const community = db.seed('publishers', { handle: 'community', ownerOrgId: null, displayName: 'Community', tier: 'unverified' });
    const orphan = db.seed('plugin_listings', { publisherId: community.id, name: 'orphan' });
    const listing = await requestsSvc.submit(tenant() as any, { kind: 'claim', target: { listingId: orphan.id } });
    expect((listing.request.payload as any).target).toEqual({ listingId: orphan.id });
    const acmeListing = db.seed('plugin_listings', { publisherId: db.tables.publishers![1]!.id, name: 'mine' });
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'claim', target: { listingId: acmeListing.id } }), 'NOT_FOUND');
  });

  it('requests handle / display-name changes against the reserved list', async () => {
    seedPublishers(db);
    const out = await requestsSvc.submit(tenant() as any, { kind: 'profile_change', target: { handle: 'acme-corp', displayName: 'Acme Corp' } });
    expect((out.request.payload as any).target).toEqual({ handle: 'acme-corp', displayName: 'Acme Corp' });
    expect(h.notify).toHaveBeenCalledWith('N24', [expect.objectContaining({ permission: 'publishers:verify' })], expect.anything(), {});
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'profile_change', target: { handle: 'official' } }), 'PUBLISHER_HANDLE_RESERVED');
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'profile_change', target: { handle: 'acme', displayName: 'Acme' } }), 'VALIDATION_ERROR');
  });

  it('applies for Verified only on an eligible plan (§3.7) and only from Community (N6)', async () => {
    const { acme } = seedPublishers(db);
    await rejects(requestsSvc.submit(tenant() as any, { kind: 'verify', application: {} }), 'VERIFIED_PLAN_REQUIRED');
    const out = await requestsSvc.submit(tenant({ features: ['verified_publisher'] }) as any, { kind: 'verify', application: { domain: 'acme.dev', notes: 'hi' } });
    expect((out.request.payload as any).application).toEqual({ domain: 'acme.dev', notes: 'hi' });
    expect((out.request.payload as any).eligibility).toMatchObject({ eligible: true, verifiedDomains: ['acme.dev'] });
    expect(h.notify).toHaveBeenCalledWith('N6', expect.anything(), expect.anything(), {});
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'publisher.verify.request' }));
    acme.tier = 'verified';
    await rejects(requestsSvc.submit(tenant({ features: ['verified_publisher'] }) as any, { kind: 'verify' }), 'CONFLICT');
  });
});

describe('withdraw + own lists', () => {
  it('withdraws an open request (releasing the freeze) and lists the org\'s requests', async () => {
    seedPublishers(db);
    const plugin = db.seed('plugins', pluginRow());
    const out = await requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id });
    expect((await requestsSvc.ownRequests(tenant() as any, { status: 'open' })).requests).toHaveLength(1);
    expect((await requestsSvc.ownRequests(tenant() as any, {})).requests).toHaveLength(1);
    expect(await requestsSvc.ownRequests(tenant({ orgId: 'none' }) as any, { status: 'open' })).toEqual({ requests: [], nextCursor: null });
    await rejects(requestsSvc.withdraw(tenant({ permissions: ['publishers:manage'] }) as any, out.request.id), 'INSUFFICIENT_PERMISSIONS');
    const w = await requestsSvc.withdraw(tenant() as any, out.request.id);
    expect(w.status).toBe('withdrawn');
    expect(plugin.frozenAt).toBeNull();
    await rejects(requestsSvc.withdraw(tenant() as any, out.request.id), 'CONFLICT');
    await rejects(requestsSvc.withdraw(tenant() as any, 'nope'), 'NOT_FOUND');
    expect((await requestsSvc.ownRequests(tenant() as any, { status: 'withdrawn' })).requests).toHaveLength(1);
  });

  it('pages the org\'s requests newest first with an opaque keyset cursor (E11)', async () => {
    const { acme } = seedPublishers(db);
    const at = Date.now();
    for (let i = 0; i < 5; i++) db.seed('plugin_publish_requests', { publisherId: acme.id, kind: 'yank', submittedBy: 'u-acme', createdAt: new Date(at - i * 1000), version: `1.0.${i}` });
    const first = await requestsSvc.ownRequests(tenant() as any, { limit: '2' });
    expect(first.requests.map((r) => r.version)).toEqual(['1.0.0', '1.0.1']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await requestsSvc.ownRequests(tenant() as any, { limit: '2', cursor: first.nextCursor });
    expect(second.requests.map((r) => r.version)).toEqual(['1.0.2', '1.0.3']);
    const last = await requestsSvc.ownRequests(tenant() as any, { limit: '2', cursor: second.nextCursor });
    expect(last).toMatchObject({ nextCursor: null });
    expect(last.requests.map((r) => r.version)).toEqual(['1.0.4']);
    await rejects(requestsSvc.ownRequests(tenant() as any, { cursor: 'garbage' }), 'VALIDATION_ERROR');
  });
});

// -----------------------------------------------------------------------------
// Automatic decisions: bootstrap + auto-approval rules
// -----------------------------------------------------------------------------

describe('bootstrap exception (§3.1)', () => {
  it('auto-approves the initial Official catalog from the loader, audited as bootstrap, then closes for good', async () => {
    seedPublishers(db);
    const lint = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, createdBy: 'sa-loader' }));
    const fmt = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, name: 'fmt', createdBy: 'sa-loader' }));

    const first = await requestsSvc.submitAfterBuild(loader() as any, lint.id);
    expect(first).toMatchObject({ ok: true, status: 'approved' });
    // A second plugin of the same load still rides the (open) window.
    expect(await requestsSvc.submitAfterBuild(loader() as any, fmt.id)).toMatchObject({ ok: true, status: 'approved' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.auto-approve', actorId: 'system', details: expect.objectContaining({ bootstrap: true }) }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.listing.publish', details: expect.objectContaining({ tier: 'official', digest: DIGEST_A }) }));
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications', expect.objectContaining({ sourceRepository: 'system/lint', tier: 'official', publisherHandle: 'pipeline-builder' }), expect.anything());
    expect(db.tables.plugin_listings).toHaveLength(2);
    expect(db.tables.plugin_listing_versions![0]).toMatchObject({ imageRepository: 'public/pipeline-builder/lint', sourcePluginId: lint.id });
    expect((await decisions.bootstrapState()).approved).toBe(2);

    // The window elapses: closed, and never reopens.
    process.env.ECOSYSTEM_BOOTSTRAP_WINDOW_HOURS = '1';
    const state = db.tables.ecosystem_settings!.find((s) => s.key === 'bootstrap')!;
    state.value = { ...state.value, openedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() };
    const late = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, name: 'late', createdBy: 'sa-loader' }));
    expect(await requestsSvc.submitAfterBuild(loader() as any, late.id)).toMatchObject({ ok: true, status: 'pending' });
    expect((await decisions.bootstrapState()).reason).toBe('window_elapsed');
  });

  it('never applies to a person, and closes when the instance already has listings', async () => {
    const { official } = seedPublishers(db);
    const lint = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG }));
    const superadmin = { ...loader(), principalType: 'user', name: 'root', isSuperAdmin: true, userId: 'u-root' };
    expect(await requestsSvc.submitAfterBuild(superadmin as any, lint.id)).toMatchObject({ status: 'pending' });

    db.reset();
    const again = seedPublishers(db);
    seedListed(again.official, 'existing', '1.0.0');
    const next = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, name: 'next' }));
    expect(await requestsSvc.submitAfterBuild(loader() as any, next.id)).toMatchObject({ status: 'pending' });
    expect((await decisions.bootstrapState()).reason).toBe('listings_exist');
    expect(official.id).toBeDefined();
  });

  it('reports the outcome of a post-build submit that cannot happen', async () => {
    const lint = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG }));
    expect(await requestsSvc.submitAfterBuild(loader() as any, lint.id)).toMatchObject({ ok: false, message: 'The organization has no publisher' });
    seedPublishers(db);
    expect(await requestsSvc.submitAfterBuild(loader() as any, 'missing')).toMatchObject({ ok: false });
    const bad = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, name: 'bad', license: null }));
    expect(await requestsSvc.submitAfterBuild(loader() as any, bad.id)).toMatchObject({ ok: false });
  });
});

describe('Official catalog auto-approval rule (§3.0.3)', () => {
  function officialWithListing() {
    const { official } = seedPublishers(db);
    seedListed(official, 'lint', '1.0.0');
    // A reviewed decision already closed the bootstrap window.
    db.seed('ecosystem_settings', { key: 'bootstrap', value: { openedAt: null, closedAt: new Date().toISOString(), reason: 'first_reviewed_decision', approved: 0 } });
    seedRules();
    return official;
  }

  it('auto-approves a gate-green minor update from the loader, with a text-only listing update alongside', async () => {
    officialWithListing();
    const next = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.1.0', summary: 'Now faster.' }));
    const out = await requestsSvc.submitAfterBuild(loader() as any, next.id);
    expect(out).toMatchObject({ ok: true, status: 'approved' });
    const rows = db.tables.plugin_publish_requests!;
    expect(rows.find((r) => r.kind === 'new_version')).toMatchObject({ status: 'approved', autoRuleId: OFFICIAL_RULE, decidedBy: 'system' });
    expect(rows.find((r) => r.kind === 'listing_update')).toMatchObject({ status: 'approved', autoRuleId: OFFICIAL_RULE });
    expect(db.tables.plugin_listings![0]).toMatchObject({ latestVersion: '1.1.0', summary: 'Now faster.' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.auto-approve', details: expect.objectContaining({ autoRuleId: OFFICIAL_RULE }) }));
    expect(h.notify).toHaveBeenCalledWith('N25', expect.arrayContaining([expect.objectContaining({ kind: 'moderators' })]), expect.anything(), {});
    // Already listed: a re-run is a no-op.
    expect(await requestsSvc.submitAfterBuild(loader() as any, next.id)).toMatchObject({ ok: true, message: expect.stringContaining('already listed') });
  });

  it('sends majors, new egress, a person\'s upload, a flag-off instance and cap overflow to two-person review', async () => {
    officialWithListing();
    const major = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '2.0.0' }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, major.id)).status).toBe('pending');

    const egress = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.1', networkEgress: ['evil.io'] }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, egress.id)).status).toBe('pending');

    const person = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.2' }));
    expect((await requestsSvc.submitAfterBuild({ ...loader(), principalType: 'user', name: 'root' } as any, person.id)).status).toBe('pending');

    process.env.OFFICIAL_AUTO_APPROVAL_ENABLED = 'false';
    const flagged = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.3' }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, flagged.id)).status).toBe('pending');
    delete process.env.OFFICIAL_AUTO_APPROVAL_ENABLED;

    const first = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.4' }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, first.id)).status).toBe('approved');
    const second = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.5' }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, second.id)).status).toBe('pending');
  });

  it('re-counts the rule\'s caps under a per-rule advisory lock in the SAME transaction as the claim (E9)', async () => {
    officialWithListing();
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();
    const locks: string[] = [];
    let raceWinner = false;
    db.execute.handler = (q) => {
      const { sql: text, params } = dialect.sqlToQuery(q as never);
      if (/pg_advisory_xact_lock/.test(text)) {
        locks.push(String(params[0]));
        // Another replica approved one under the same rule while this one waited on the lock.
        if (raceWinner) {
          const any = db.tables.plugin_publish_requests!.find((r) => r.version === '1.0.4')!;
          db.seed('plugin_publish_requests', { ...any, id: undefined, version: '9.9.9', status: 'approved', autoRuleId: OFFICIAL_RULE, decidedAt: new Date() });
        }
      }
      return { rows: [] };
    };
    const first = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.4' }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, first.id)).status).toBe('approved');
    expect(locks).toEqual([`ecosystem-auto-rule:${OFFICIAL_RULE}`]);
    // The listing's daily slot is used: a second version waits, even though the
    // unlocked pre-check ran before the competing approval landed.
    raceWinner = true;
    db.tables.plugin_publish_requests!.filter((r) => r.version === '1.0.4').forEach((r) => { r.decidedAt = new Date(Date.now() - 48 * 3_600_000); });
    const second = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, version: '1.0.5' }));
    expect((await requestsSvc.submitAfterBuild(loader() as any, second.id)).status).toBe('pending');
  });

  it('auto-approves a Verified publisher\'s patch through the Verified rule, and leaves it pending when publishing fails', async () => {
    const { acme } = seedPublishers(db, { tenantTier: 'verified' });
    seedListed(acme, 'lint', '1.0.0');
    seedRules();
    const patch = db.seed('plugins', pluginRow({ version: '1.0.1' }));
    const ok = await requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: patch.id });
    expect(ok).toMatchObject({ autoApproved: true, request: expect.objectContaining({ status: 'approved', autoRuleId: VERIFIED_RULE }) });

    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 502, body: { message: 'registry down' } }));
    const next = db.seed('plugins', pluginRow({ version: '1.0.2' }));
    const failed = await requestsSvc.submit(tenant() as any, { kind: 'new_version', pluginId: next.id });
    expect(failed.autoApproved).toBe(false);
    expect(failed.request.status).toBe('pending');
    expect(db.tables.plugin_publish_requests!.find((r) => r.version === '1.0.2')).toMatchObject({ status: 'pending', autoRuleId: null });
  });
});
