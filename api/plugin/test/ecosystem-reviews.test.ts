// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reviews and ratings ( N15–N19)
 * against the in-memory database: writing, editing and deleting a review;
 * self-promotion, the per-org daily cap, the reviews flag and machine
 * credentials; the anomaly holds (link filter, bursts of unverified reviews,
 * reports, security reports and the advisory hook); "helpful" votes; the
 * publisher's reply; the viewer's state; the moderation queue; and the
 * plugin_stats upkeep (the weighted Bayesian score, recent-versions rating,
 * install counts and k-anonymous adoption) including the in-app catalog.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';

import { SYSTEM_ORG, moderator, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const reviewsSvc = await import('../src/services/ecosystem/reviews.js');
const moderation = await import('../src/services/ecosystem/review-moderation.js');
const stats = await import('../src/services/ecosystem/stats.js');
const installs = await import('../src/services/ecosystem/installs.js');
await wireEcosystemHarness(h);

const { db } = h;
const dialect = new PgDialect();
const verified = jest.fn(async (_org: string, _pub: string, _name: string) => false);
const ENV = ['PLUGIN_REVIEWS_ENABLED', 'REVIEW_ORG_DAILY_LIMIT', 'REVIEW_AUTO_HOLD_REPORTS'];

beforeEach(() => {
  db.reset();
  h.notify.mockClear();
  h.audit.mockClear();
  verified.mockReset();
  verified.mockResolvedValue(false);
  reviewsSvc.setVerifiedUseProbeForTests(verified);
});

afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REVIEWER = (over: Record<string, unknown> = {}) => tenant({ userId: 'u-bob', orgId: 'org-b', name: 'bob@example.com', permissions: ['plugins:read'], ...over }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MANAGER = (over: Record<string, unknown> = {}) => tenant({ userId: 'u-acme', orgId: 'org-acme', permissions: ['plugins:read', 'publishers:manage'], ...over }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MOD = () => moderator() as any;

async function rejects(p: Promise<unknown>, code: string): Promise<any> {
  try {
    await p;
  } catch (err) {
    expect((err as { code: string }).code).toBe(code);
    return err;
  }
  throw new Error(`expected ${code}`);
}

function seedListing(extra: Record<string, unknown> = {}) {
  const pubs = seedPublishers(db, { tenantTier: 'verified' });
  const listing = db.seed('plugin_listings', { publisherId: pubs.acme.id, name: 'lint', category: 'quality', latestVersion: '1.2.0', ...extra });
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
    db.seed('plugin_listing_versions', { listingId: listing.id, version, publishedBy: 'system' });
  }
  return { ...pubs, listing };
}

const statsRow = (listingId: string) => (db.tables.plugin_stats ?? []).find((s) => s.listingId === listingId);
const lastAudit = () => (h.audit.mock.calls.at(-1)?.[0] ?? {}) as Record<string, any>;
const notices = (event: string) => h.notify.mock.calls.filter((c) => c[0] === event);

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

describe('createReview', () => {
  it('publishes a verified review: display name only, audit, hourly N15 per listing, stats', async () => {
    const { listing, acme } = seedListing();
    verified.mockResolvedValue(true);
    const { review } = await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 5, title: 'Great', body: 'Works **well**' });
    expect(review).toMatchObject({ rating: 5, title: 'Great', bodyMd: 'Works **well**', status: 'published', verifiedUse: true, version: '1.2.0', reply: null, moderationReason: null });
    expect(review.bodyHtml).toContain('<strong>well</strong>');
    const row = db.tables.plugin_reviews![0]!;
    expect(row).toMatchObject({ authorUserId: 'u-bob', authorOrgId: 'org-b', authorDisplayName: 'bob', holdReason: null });
    expect(verified).toHaveBeenCalledWith('org-b', 'acme', 'lint');
    expect(lastAudit()).toMatchObject({
      action: 'plugin.review.create',
      orgId: 'org-b',
      affectedOrgId: 'org-acme',
      targetType: 'plugin_review',
      details: { listing: 'acme/lint', rating: 5, version: '1.2.0', verifiedUse: true },
    });
    expect(JSON.stringify(lastAudit())).not.toContain('Works');
    const [n15] = notices('N15');
    expect(n15![1]).toEqual([{ kind: 'org_permission', orgId: 'org-acme', permission: 'publishers:manage' }]);
    expect(n15![2]).toMatchObject({ subject: 'New review on acme/lint: ★★★★★' });
    expect(n15![3]).toEqual({ digestKey: `N15:${listing.id}` });
    expect((n15![2] as { text: string }).text).toContain('bob reviewed');
    expect((n15![2] as { text: string }).text).not.toContain('org-b');
    // (10 × 3.5 + 1 × 5) / 11
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 1, ratingBayes: 3.636, recentRating: 3.636, dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } });
    expect(acme).toBeDefined();
  });

  it('validates the input and the version', async () => {
    seedListing();
    const me = REVIEWER();
    await rejects(reviewsSvc.createReview(me, 'acme', 'lint', { rating: 0 }), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.createReview(me, 'acme', 'lint', { rating: 4.5 }), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.createReview(me, 'acme', 'lint', { rating: 4, title: 'x'.repeat(121) }), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.createReview(me, 'acme', 'lint', { rating: 4, body: 'x'.repeat(5001) }), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.createReview(me, 'acme', 'lint', { rating: 4, orgId: 'x' }), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.createReview(me, 'acme', 'lint', { rating: 4, version: '9.9.9' }), 'VALIDATION_ERROR');
    const { review } = await reviewsSvc.createReview(me, 'acme', 'lint', { rating: 4, title: '  ', body: '', version: '1.0.0' });
    expect(review).toMatchObject({ title: null, bodyMd: null, bodyHtml: null, version: '1.0.0' });
  });

  it('records no version when asked, and a nameless account gets a generic display name', async () => {
    seedListing();
    await reviewsSvc.createReview(REVIEWER({ name: undefined }), 'acme', 'lint', { rating: 3, version: null });
    expect(db.tables.plugin_reviews![0]).toMatchObject({ version: null, authorDisplayName: 'Pipeline Builder user' });
  });

  it('refuses self-promotion — the publisher\'s org and its teams', async () => {
    seedListing();
    await rejects(reviewsSvc.createReview(MANAGER(), 'acme', 'lint', { rating: 5 }), 'REVIEW_SELF_PROMOTION');
    await rejects(reviewsSvc.createReview(REVIEWER({ orgId: 'team-1', parentOrgId: 'org-acme' }), 'acme', 'lint', { rating: 5 }), 'REVIEW_SELF_PROMOTION');
    expect(db.tables.plugin_reviews ?? []).toHaveLength(0);
  });

  it('allows one review per user per listing', async () => {
    seedListing();
    await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 4 });
    await rejects(reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 2 }), 'DUPLICATE_ENTRY');
  });

  it('caps new reviews per org per day', async () => {
    const { listing } = seedListing();
    process.env.REVIEW_ORG_DAILY_LIMIT = '2';
    db.seed('plugin_reviews', { listingId: listing.id, rating: 3, authorUserId: 'u-1', authorOrgId: 'org-b' });
    db.seed('plugin_reviews', { listingId: listing.id, rating: 3, authorUserId: 'u-2', authorOrgId: 'org-b', createdAt: new Date(Date.now() - 2 * 86_400_000) });
    await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 4 });
    const err = await rejects(reviewsSvc.createReview(REVIEWER({ userId: 'u-3' }), 'acme', 'lint', { rating: 4 }), 'RATE_LIMIT_EXCEEDED');
    expect(err.details).toEqual({ reason: 'org_daily_limit', limit: 2 });
  });

  it('is read-only with the flag off, and refuses machine credentials', async () => {
    seedListing();
    process.env.PLUGIN_REVIEWS_ENABLED = 'false';
    await rejects(reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 4 }), 'PLUGIN_REVIEWS_DISABLED');
    delete process.env.PLUGIN_REVIEWS_ENABLED;
    await rejects(reviewsSvc.createReview(REVIEWER({ principalType: 'service_account' }), 'acme', 'lint', { rating: 4 }), 'HUMAN_SESSION_REQUIRED');
  });

  it('answers 404 for listings that are not public', async () => {
    const { acme } = seedListing();
    db.seed('plugin_listings', { publisherId: acme.id, name: 'paused', pausedAt: new Date() });
    db.seed('plugin_listings', { publisherId: acme.id, name: 'gone', state: 'suspended' });
    for (const name of ['paused', 'gone', 'nope']) await rejects(reviewsSvc.createReview(REVIEWER(), 'acme', name, { rating: 4 }), 'NOT_FOUND');
    await rejects(reviewsSvc.createReview(REVIEWER(), 'nobody', 'lint', { rating: 4 }), 'NOT_FOUND');
    acme.suspendedAt = new Date();
    await rejects(reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 4 }), 'NOT_FOUND');
  });

  it('holds a review with too many links (filter) — N17 to moderators, not in the score', async () => {
    const { listing } = seedListing();
    const { review } = await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', {
      rating: 5, body: 'see https://a.io https://b.io www.c.io and https://d.io',
    });
    expect(review.status).toBe('held');
    expect(db.tables.plugin_reviews![0]!.holdReason).toBe('filter');
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.create', details: { held: 'filter' } });
    expect(notices('N15')).toHaveLength(0);
    const [n17] = notices('N17');
    expect(n17![1]).toEqual([{ kind: 'moderators', permission: 'plugins:moderate' }]);
    expect((n17![2] as { text: string }).text).toContain('the link filter');
    expect(statsRow(listing.id)).toBeUndefined();
  });

  it('holds a burst of unverified reviews on one listing; a verified reviewer is not held', async () => {
    const { listing } = seedListing();
    for (let i = 0; i < 4; i++) db.seed('plugin_reviews', { listingId: listing.id, rating: 5, authorUserId: `u-${i}`, authorOrgId: `org-${i}` });
    db.seed('plugin_reviews', { listingId: listing.id, rating: 5, authorUserId: 'u-old', authorOrgId: 'org-old', createdAt: new Date(Date.now() - 2 * 3_600_000) });
    const { review } = await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 5 });
    expect(review.status).toBe('held');
    expect(db.tables.plugin_reviews!.find((r) => r.id === review.id)!.holdReason).toBe('burst');
    verified.mockResolvedValue(true);
    expect((await reviewsSvc.createReview(REVIEWER({ userId: 'u-carol' }), 'acme', 'lint', { rating: 5 })).review.status).toBe('published');
  });

  it('counts the review as unverified when the verified-use probe fails', async () => {
    seedListing();
    verified.mockRejectedValue(new Error('reporting down'));
    expect((await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 4 })).review.verifiedUse).toBe(false);
  });
});

describe('updateReview / deleteReview', () => {
  async function mine() {
    const ctx = seedListing();
    const { review } = await reviewsSvc.createReview(REVIEWER(), 'acme', 'lint', { rating: 2, title: 'Meh', body: 'slow' });
    h.notify.mockClear();
    h.audit.mockClear();
    return { ...ctx, review };
  }

  it('edits: prior text into history, audit of the changed fields, N15 "updated", stats', async () => {
    const { review, listing } = await mine();
    verified.mockResolvedValue(true);
    const out = await reviewsSvc.updateReview(REVIEWER(), review.id, { rating: 4, body: 'faster now', version: '1.1.0' });
    expect(out.review).toMatchObject({ rating: 4, bodyMd: 'faster now', title: 'Meh', version: '1.1.0', verifiedUse: true });
    expect(db.tables.plugin_review_history).toEqual([expect.objectContaining({ reviewId: review.id, rating: 2, title: 'Meh', bodyMd: 'slow', version: '1.2.0' })]);
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.update', details: { changed: ['rating', 'bodyMd', 'version'], rating: 4 } });
    expect((notices('N15')[0]![2] as { subject: string }).subject).toBe('Review updated on acme/lint: ★★★★☆');
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 1, dist: expect.objectContaining({ 4: 1, 2: 0 }) });
  });

  it('an unchanged edit writes nothing; clearing fields works', async () => {
    const { review } = await mine();
    await reviewsSvc.updateReview(REVIEWER(), review.id, { rating: 2, title: 'Meh' });
    expect(db.tables.plugin_review_history ?? []).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
    const out = await reviewsSvc.updateReview(REVIEWER(), review.id, { title: null, body: null, version: null });
    expect(out.review).toMatchObject({ title: null, bodyMd: null, bodyHtml: null, version: null });
  });

  it('an edit that trips the link filter goes back to moderation', async () => {
    const { review } = await mine();
    const out = await reviewsSvc.updateReview(REVIEWER(), review.id, { body: 'https://a https://b https://c https://d' });
    expect(out.review.status).toBe('held');
    expect(notices('N17')).toHaveLength(1);
    expect(notices('N15')).toHaveLength(0);
  });

  it('only the author edits or deletes; a removed review is final', async () => {
    const { review } = await mine();
    await rejects(reviewsSvc.updateReview(REVIEWER({ userId: 'u-eve' }), review.id, { rating: 1 }), 'NOT_FOUND');
    await rejects(reviewsSvc.deleteReview(REVIEWER({ userId: 'u-eve' }), review.id), 'NOT_FOUND');
    await rejects(reviewsSvc.updateReview(REVIEWER(), 'not-a-uuid', { rating: 1 }), 'NOT_FOUND');
    await rejects(reviewsSvc.updateReview(REVIEWER(), review.id, { rating: 9 }), 'VALIDATION_ERROR');
    db.tables.plugin_reviews![0]!.status = 'removed';
    await rejects(reviewsSvc.updateReview(REVIEWER(), review.id, { rating: 1 }), 'CONFLICT');
  });

  it('deletes: audit and the listing loses the rating', async () => {
    const { review, listing } = await mine();
    expect(await reviewsSvc.deleteReview(REVIEWER(), review.id)).toEqual({ deleted: true });
    expect(db.tables.plugin_reviews).toEqual([]);
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.delete', targetId: review.id, affectedOrgId: 'org-acme' });
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 0, ratingBayes: null });
  });
});

// -----------------------------------------------------------------------------
// Votes, reports, replies
// -----------------------------------------------------------------------------

async function published(extra: Record<string, unknown> = {}) {
  const ctx = seedListing();
  const review = db.seed('plugin_reviews', {
    listingId: ctx.listing.id,
    version: '1.2.0',
    rating: 4,
    title: 'Good',
    bodyMd: 'ok',
    bodyHtml: '<p>ok</p>',
    authorUserId: 'u-bob',
    authorOrgId: 'org-b',
    authorDisplayName: 'bob',
    ...extra,
  });
  return { ...ctx, review };
}

describe('setHelpful', () => {
  it('one vote per user; the count follows; nothing is audited', async () => {
    const { review } = await published();
    const carol = REVIEWER({ userId: 'u-carol', orgId: 'org-c' });
    expect(await reviewsSvc.setHelpful(carol, review.id, true)).toEqual({ helpfulCount: 1, voted: true });
    expect(await reviewsSvc.setHelpful(carol, review.id, true)).toEqual({ helpfulCount: 1, voted: true });
    expect(await reviewsSvc.setHelpful(REVIEWER({ userId: 'u-dan', orgId: 'org-d' }), review.id, true)).toEqual({ helpfulCount: 2, voted: true });
    expect(review.helpfulCount).toBe(2);
    expect(await reviewsSvc.setHelpful(carol, review.id, false)).toEqual({ helpfulCount: 1, voted: false });
    expect(await reviewsSvc.setHelpful(carol, review.id, false)).toEqual({ helpfulCount: 1, voted: false });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('refuses the author, the publisher\'s org, and held reviews', async () => {
    const { review } = await published();
    await rejects(reviewsSvc.setHelpful(REVIEWER(), review.id, true), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.setHelpful(MANAGER(), review.id, true), 'REVIEW_SELF_PROMOTION');
    review.status = 'held';
    await rejects(reviewsSvc.setHelpful(REVIEWER({ userId: 'u-carol' }), review.id, true), 'NOT_FOUND');
  });
});

describe('reportReview', () => {
  it('holds after N distinct reports (N17) — the reporter never learns it, the text never reaches audit', async () => {
    const { review, listing } = await published();
    process.env.REVIEW_AUTO_HOLD_REPORTS = '2';
    expect(await reviewsSvc.reportReview(REVIEWER({ userId: 'u-1' }), review.id, { category: 'spam', reason: 'buy now' })).toEqual({ reported: true });
    expect(review.status).toBe('published');
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.report', details: { listing: 'acme/lint', category: 'spam' } });
    expect(JSON.stringify(lastAudit())).not.toContain('buy now');
    await rejects(reviewsSvc.reportReview(REVIEWER({ userId: 'u-1' }), review.id, { category: 'abuse' }), 'DUPLICATE_ENTRY');
    await reviewsSvc.reportReview(REVIEWER({ userId: 'u-2' }), review.id, { category: 'abuse' });
    expect(review).toMatchObject({ status: 'held', holdReason: 'reports' });
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.hold', actorId: 'system', orgId: SYSTEM_ORG, details: { reason: 'reports', trigger: 'reports' } });
    expect(notices('N17')).toHaveLength(1);
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 0 });
  });

  it('refuses reporting your own review, a bad category and removed reviews', async () => {
    const { review } = await published();
    await rejects(reviewsSvc.reportReview(REVIEWER(), review.id, { category: 'spam' }), 'VALIDATION_ERROR');
    await rejects(reviewsSvc.reportReview(REVIEWER({ userId: 'u-1' }), review.id, { category: 'rude' }), 'VALIDATION_ERROR');
    review.status = 'removed';
    await rejects(reviewsSvc.reportReview(REVIEWER({ userId: 'u-1' }), review.id, { category: 'spam' }), 'NOT_FOUND');
  });

  it('a SECURITY report holds at once, notifies privately (N19) and opens the private advisory draft', async () => {
    const { review } = await published();
    await reviewsSvc.reportReview(REVIEWER({ userId: 'u-sec', orgId: 'org-s' }), review.id, { category: 'security', reason: 'token leaks in logs' });
    expect(review).toMatchObject({ status: 'held', holdReason: 'security' });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.review.hold', details: expect.objectContaining({ reason: 'security', trigger: 'security_report' }) }));
    const [n19] = notices('N19');
    expect(n19![1]).toEqual([
      { kind: 'org_permission', orgId: 'org-acme', permission: 'publishers:manage' },
      { kind: 'moderators', permission: 'plugins:moderate' },
    ]);
    expect(n19![3]).toEqual({ immediate: true, mandatory: true });
    expect((n19![2] as { text: string }).text).toContain('token leaks in logs');
    expect(notices('N17')).toHaveLength(0);
    expect(db.tables.plugin_advisories).toEqual([expect.objectContaining({ source: 'review', affectedRange: '1.2.0' })]);
    const draft = db.tables.plugin_publish_requests!.find((r) => r.kind === 'advisory')!;
    expect(draft.payload).toMatchObject({ reviewId: review.id, reportDetails: 'token leaks in logs' });
  });

  it('a security report on an already-held review still notifies and dispatches; a missing or failing handler never fails the report', async () => {
    const { review } = await published({ status: 'held', holdReason: 'burst' });
    expect(await reviewsSvc.reportReview(REVIEWER({ userId: 'u-1' }), review.id, { category: 'security' })).toEqual({ reported: true });
    expect(review.holdReason).toBe('burst');
    expect(notices('N19')).toHaveLength(1);
    db.failNextInsert('plugin_advisories', new Error('advisories down'));
    db.tables.plugin_publish_requests = [];
    db.tables.plugin_advisories = [];
    expect(await reviewsSvc.reportReview(REVIEWER({ userId: 'u-2' }), review.id, { category: 'security' })).toEqual({ reported: true });
    expect(db.tables.plugin_advisories).toEqual([]);
  });
});

describe('publisher reply', () => {
  it('creates (N16 to the author), then edits (no second N16), then deletes — each audited', async () => {
    const { review } = await published();
    const { reply } = await reviewsSvc.putReply(MANAGER(), review.id, { body: 'Thanks, **fixed** in 1.3' });
    expect(reply).toMatchObject({ bodyMd: 'Thanks, **fixed** in 1.3', publisherDisplayName: 'Acme' });
    expect(reply.bodyHtml).toContain('<strong>fixed</strong>');
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.reply.create', orgId: 'org-acme', affectedOrgId: 'org-acme' });
    const [n16] = notices('N16');
    expect(n16![1]).toEqual([{ kind: 'user', userId: 'u-bob', orgId: 'org-b' }]);
    await reviewsSvc.putReply(MANAGER(), review.id, { body: 'Edited' });
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.reply.update' });
    expect(notices('N16')).toHaveLength(1);
    expect(db.tables.plugin_review_replies).toHaveLength(1);
    expect(await reviewsSvc.deleteReply(MANAGER(), review.id)).toEqual({ deleted: true });
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.reply.delete' });
    await rejects(reviewsSvc.deleteReply(MANAGER(), review.id), 'NOT_FOUND');
  });

  it('only the publisher org\'s managers reply, only to published reviews, with a body', async () => {
    const { review } = await published({ authorUserId: null, authorDisplayName: null });
    await rejects(reviewsSvc.putReply(MANAGER({ permissions: ['plugins:read'] }), review.id, { body: 'x' }), 'INSUFFICIENT_PERMISSIONS');
    await rejects(reviewsSvc.putReply(MANAGER({ orgId: 'org-b' }), review.id, { body: 'x' }), 'INSUFFICIENT_PERMISSIONS');
    await rejects(reviewsSvc.putReply(MANAGER(), review.id, { body: '   ' }), 'VALIDATION_ERROR');
    // An anonymized review gets its reply but no N16.
    await reviewsSvc.putReply(MANAGER(), review.id, { body: 'ok' });
    expect(notices('N16')).toHaveLength(0);
    review.status = 'held';
    await rejects(reviewsSvc.putReply(MANAGER(), review.id, { body: 'x' }), 'NOT_FOUND');
  });
});

describe('reviewState', () => {
  it('tells the viewer what they may do, with their own review and votes', async () => {
    const { review, listing } = await published();
    const other = db.seed('plugin_reviews', { listingId: listing.id, rating: 1, authorUserId: 'u-x', authorOrgId: 'org-x' });
    db.seed('plugin_review_votes', { reviewId: other.id, userId: 'u-bob' });
    db.seed('plugin_review_reports', { reviewId: other.id, reporterUserId: 'u-bob' });
    db.seed('plugin_review_replies', { reviewId: review.id, publisherId: listing.publisherId, bodyMd: 'hi', bodyHtml: '<p>hi</p>' });
    verified.mockResolvedValue(true);
    const state = await reviewsSvc.reviewState(REVIEWER(), 'acme', 'lint');
    expect(state).toMatchObject({
      myReview: { id: review.id, status: 'published', reply: { bodyHtml: '<p>hi</p>', publisherDisplayName: 'Acme' } },
      helpfulReviewIds: [other.id],
      reportedReviewIds: [other.id],
      canReview: true,
      reviewBlockedReason: null,
      canReply: false,
      verifiedUse: true,
    });
    expect(await reviewsSvc.reviewState(MANAGER(), 'acme', 'lint')).toMatchObject({ myReview: null, canReview: false, reviewBlockedReason: 'own_publisher', canReply: true });
    expect(await reviewsSvc.reviewState(REVIEWER({ principalType: 'service_account' }), 'acme', 'lint')).toMatchObject({ canReview: false, reviewBlockedReason: 'machine_credential' });
    process.env.PLUGIN_REVIEWS_ENABLED = 'false';
    expect(await reviewsSvc.reviewState(MANAGER(), 'acme', 'lint')).toMatchObject({ canReview: false, reviewBlockedReason: 'reviews_disabled', canReply: false });
  });

  it('shows the author why a removed review was removed', async () => {
    await published({ status: 'removed', moderationReason: 'Off-topic' });
    expect((await reviewsSvc.reviewState(REVIEWER(), 'acme', 'lint')).myReview).toMatchObject({ status: 'removed', moderationReason: 'Off-topic' });
  });
});

// -----------------------------------------------------------------------------
// Moderation
// -----------------------------------------------------------------------------

describe('review moderation', () => {
  it('queues held and reported reviews (open) and removed ones, with reports and replies', async () => {
    const { review, listing } = await published({ updatedAt: new Date(Date.now() - 60_000) });
    const held = db.seed('plugin_reviews', { listingId: listing.id, rating: 1, authorUserId: 'u-x', authorDisplayName: 'x', status: 'held', holdReason: 'burst' });
    db.seed('plugin_reviews', { listingId: listing.id, rating: 5, authorUserId: 'u-y', status: 'removed', moderationReason: 'spam' });
    db.seed('plugin_review_reports', { reviewId: review.id, reporterUserId: 'u-1', category: 'abuse', reason: 'rude' });
    db.seed('plugin_review_reports', { reviewId: review.id, reporterUserId: 'u-2', category: 'spam', resolvedAt: new Date() });
    db.seed('plugin_review_replies', { reviewId: review.id, publisherId: listing.publisherId, bodyMd: 'r', bodyHtml: '<p>r</p>' });

    const open = await moderation.reviewQueue({});
    expect(open.reviews.map((r) => r.id)).toEqual([held.id, review.id]);
    expect(open.reviews[0]).toMatchObject({ status: 'held', holdReason: 'burst', listing: { publisher: 'acme', name: 'lint' }, author: { userId: 'u-x', displayName: 'x' }, openReportCount: 0 });
    expect(open.reviews[1]).toMatchObject({
      openReportCount: 1,
      reply: { bodyHtml: '<p>r</p>', publisherDisplayName: 'Acme' },
      reports: expect.arrayContaining([
        expect.objectContaining({ category: 'abuse', reason: 'rude', resolved: false }),
        expect.objectContaining({ category: 'spam', resolved: true }),
      ]),
    });
    expect(JSON.stringify(open)).not.toContain('org-b');
    expect((await moderation.reviewQueue({ queue: 'removed' })).reviews).toEqual([expect.objectContaining({ status: 'removed', moderationReason: 'spam' })]);
    expect(await moderation.reviewQueueCounts()).toEqual({ held: 1, reported: 1 });
  });

  it('hold → release (N15, reports resolved, back in the score) — audited as the system org', async () => {
    const { review, listing } = await published();
    db.seed('plugin_review_reports', { reviewId: review.id, reporterUserId: 'u-1' });
    await rejects(moderation.holdReview(MOD(), review.id, {}), 'MISSING_REQUIRED_FIELD');
    const heldOut = await moderation.holdReview(MOD(), review.id, { reason: 'checking' });
    expect(heldOut.review).toMatchObject({ status: 'held', holdReason: 'moderator', moderationReason: 'checking' });
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.hold', actorId: 'mod-1', orgId: SYSTEM_ORG, affectedOrgId: 'org-acme', details: { listing: 'acme/lint', reason: 'moderator' } });
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 0 });
    await rejects(moderation.holdReview(MOD(), review.id, { reason: 'again' }), 'CONFLICT');

    const released = await moderation.releaseReview(MOD(), review.id, { note: 'fine' });
    expect(released.review).toMatchObject({ status: 'published', holdReason: null, moderationReason: null, openReportCount: 0 });
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.release', details: { from: 'held', heldFor: 'moderator', note: 'fine' } });
    expect(notices('N15')).toHaveLength(1);
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 1 });
  });

  it('release on a published, reported review just clears its reports', async () => {
    const { review } = await published();
    db.seed('plugin_review_reports', { reviewId: review.id, reporterUserId: 'u-1' });
    await moderation.releaseReview(MOD(), review.id, {});
    expect(db.tables.plugin_review_reports![0]!.resolvedAt).toBeInstanceOf(Date);
    expect(notices('N15')).toHaveLength(0);
  });

  it('remove: N18 to the author with the reason (transactional); final', async () => {
    const { review, listing } = await published();
    const out = await moderation.removeReview(MOD(), review.id, { reason: 'Personal attack' });
    expect(out.review).toMatchObject({ status: 'removed', moderationReason: 'Personal attack' });
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.remove', details: { from: 'published' } });
    const [n18] = notices('N18');
    expect(n18![1]).toEqual([{ kind: 'user', userId: 'u-bob', orgId: 'org-b' }]);
    expect((n18![2] as { text: string }).text).toContain('Personal attack');
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 0 });
    await rejects(moderation.removeReview(MOD(), review.id, { reason: 'x' }), 'CONFLICT');
    await rejects(moderation.releaseReview(MOD(), review.id, {}), 'CONFLICT');
  });

  it('removes a publisher reply', async () => {
    const { review, listing } = await published();
    db.seed('plugin_review_replies', { reviewId: review.id, publisherId: listing.publisherId, bodyMd: 'r', bodyHtml: '<p>r</p>' });
    await rejects(moderation.removeReply(MOD(), review.id, {}), 'MISSING_REQUIRED_FIELD');
    expect((await moderation.removeReply(MOD(), review.id, { reason: 'abusive' })).review.reply).toBeNull();
    expect(lastAudit()).toMatchObject({ action: 'plugin.review.reply.delete', orgId: SYSTEM_ORG, details: { by: 'moderator' } });
    await rejects(moderation.removeReply(MOD(), review.id, { reason: 'x' }), 'NOT_FOUND');
    await rejects(moderation.holdReview(MOD(), 'nope', { reason: 'x' }), 'NOT_FOUND');
  });
});

// -----------------------------------------------------------------------------
// plugin_stats
// -----------------------------------------------------------------------------

describe('plugin_stats', () => {
  it('weighs unverified reviews at half in the Bayesian average (prior 3.5 over 10)', () => {
    expect(stats.bayesianRating([])).toBeNull();
    expect(stats.bayesianRating([{ rating: 5, verifiedUse: true }])).toBe(3.636);
    expect(stats.bayesianRating([{ rating: 5, verifiedUse: false }])).toBe(3.571);
    expect(stats.bayesianRating(Array.from({ length: 90 }, () => ({ rating: 1, verifiedUse: true })))).toBe(1.25);
  });

  it('rates the last two minor lines as "recent versions"', () => {
    expect([...stats.recentMinorLines(['1.0.0', '2.1.3', '2.1.0', 'junk', '2.0.5', '1.9.0'])]).toEqual(['2.1', '2.0']);
    const out = stats.ratingStats([
      { rating: 5, verifiedUse: true, version: '2.1.0' },
      { rating: 1, verifiedUse: true, version: '1.0.0' },
      { rating: 3, verifiedUse: true, version: null },
    ], ['1.0.0', '2.0.0', '2.1.0']);
    expect(out).toMatchObject({ ratingCount: 3, dist: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 }, recentRating: 3.636 });
  });

  it('the sweep writes ratings, install counts and adoption for every listing', async () => {
    const { listing, official } = seedListing();
    const other = db.seed('plugin_listings', { publisherId: official.id, name: 'trivy' });
    db.seed('plugin_reviews', { listingId: listing.id, rating: 4, verifiedUse: true, version: '1.2.0' });
    db.seed('plugin_reviews', { listingId: listing.id, rating: 1, status: 'held' });
    db.seed('plugin_stats', { listingId: other.id, installCount: 99 });
    const seen: string[] = [];
    db.execute.handler = (q) => {
      const text = dialect.sqlToQuery(q as never).sql;
      seen.push(text);
      if (text.includes('plugin_installs')) return { rows: [{ listingId: listing.id, installCount: '7' }] };
      if (text.includes('pipeline_events')) return { rows: [{ listingId: listing.id, activeOrgCount: 6, successRate30d: '0.75' }, { listingId: other.id, activeOrgCount: 2, successRate30d: null }] };
      return { rows: [] };
    };
    expect(await stats.refreshAllStats()).toEqual({ listings: 2, failures: 0 });
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 1, ratingBayes: 3.545, installCount: 7, activeOrgCount: 6, successRate30d: 0.75 });
    expect(statsRow(other.id)).toMatchObject({ ratingCount: 0, ratingBayes: null, installCount: 0, activeOrgCount: 2, successRate30d: null });
    expect(seen.some((s) => s.includes('pipeline_step_manifests'))).toBe(true);
    expect(seen.find((s) => s.includes('pipeline_events'))).toMatch(/COUNT\(DISTINCT e\.org_id\)/);
  });

  it('a lost insert race retries as an update and never throws; the next sweep writes the row', async () => {
    const { listing } = seedListing();
    db.failNextInsert('plugin_stats', new Error('duplicate key'));
    await stats.refreshListingRating(listing.id);
    expect(statsRow(listing.id)).toBeUndefined();
    expect(await stats.refreshAllStats()).toEqual({ listings: 1, failures: 0 });
    expect(statsRow(listing.id)).toMatchObject({ ratingCount: 0 });
  });

  it('the in-app catalog and install state carry the rating and install count', async () => {
    const { listing } = seedListing();
    db.seed('plugin_stats', { listingId: listing.id, ratingBayes: 4.1234, ratingCount: 12, installCount: 30 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const member = tenant({ userId: 'u-m', orgId: 'org-b', permissions: ['plugins:read', 'plugins:install'] }) as any;
    const { listings } = await installs.catalog(member, {});
    expect(listings.find((e) => e.listing.name === 'lint')).toMatchObject({ rating: { score: 4.12, count: 12 }, installCount: 30 });
    const state = await installs.installState(member, 'acme', 'lint');
    expect(state.entry).toMatchObject({ rating: { score: 4.12, count: 12 }, installCount: 30 });
    db.tables.plugin_stats![0]!.ratingCount = 0;
    expect((await installs.installState(member, 'acme', 'lint')).entry.rating).toBeNull();
  });

  it('builds a leader-locked scheduler', () => {
    const s = stats.createEcosystemStatsScheduler(() => ({}) as never);
    expect(typeof s.start).toBe('function');
    s.stop();
  });
});
