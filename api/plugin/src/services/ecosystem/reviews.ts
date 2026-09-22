// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reviews and ratings (docs/plugin-publishing.md): the
 * signed-in half — write, edit, delete, "helpful", report, publisher reply and
 * the viewer's own state for a listing. The anonymous read is the public
 * directory's `public_reviews` view (pipeline-data `listPublicReviews`).
 *
 * Integrity:
 *  - one review per user per listing (edits keep the prior text in history);
 *  - nobody from the publisher's own org (or a team under it) may review or
 *    vote on its listings — `REVIEW_SELF_PROMOTION`;
 *  - at most {@link REVIEW_ORG_DAILY_LIMIT} new reviews per org per day (here)
 *    and per trusted client IP (the route's rate limiter);
 *  - anomaly HOLDS instead of publishing: a burst of unverified reviews on one
 *    listing, too many links (spam filter), N distinct reports, or a security
 * report;
 *  - "verified use" (the org ran it successfully in the last 90 days) is
 *    decided server-side at write time; unverified reviews weigh half in the
 *    Bayesian score (stats.ts).
 *
 * Writes require a PERSON (the route gates `requireAssurance({ minAssurance: 1 })`:
 * service accounts and exchanged access keys get `HUMAN_SESSION_REQUIRED`) and
 * are refused while `PLUGIN_REVIEWS_ENABLED` is off. Markdown is rendered
 * server-side (no raw HTML, no images, links `rel="nofollow ugc noopener"`);
 * only the stored HTML is ever served.
 */

import {
  actorId,
  createLogger,
  ErrorCode,
  errorMessage,
  isPluginReviewsEnabled,
  SYSTEM_ACTOR_ID,
  SYSTEM_ORG_ID,
  envInt,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
import {
  REVIEW_REPORT_CATEGORIES,
  reportingService,
  type PluginListing,
  type PluginReview,
  type PluginReviewReply,
  type Publisher,
  type ReviewHoldReason,
  type ReviewReportCategory,
} from '@pipeline-builder/pipeline-data';
import { z } from 'zod';

import { openReviewAdvisoryDraft } from './advisories.js';
import { ecosystemAudit } from './audit.js';
import { can, EcosystemError, type Caller } from './context.js';
import { notifyReplied, notifyReviewHeld, notifyReviewPosted, notifySecurityReport } from './review-notify.js';
import { replies, reports, reviewHistory, reviews, votes } from './reviews-store.js';
import { refreshListingRating } from './stats.js';
import { listings, publishers, versions } from './store.js';
import { DAY_MS, isActiveListing, iso } from './util.js';

const logger = createLogger('ecosystem-reviews');

/** Per-org cap on NEW reviews in a rolling day; `REVIEW_ORG_DAILY_LIMIT` overrides. */
export const REVIEW_ORG_DAILY_LIMIT_DEFAULT = 20;
/** Distinct open reports that auto-hold a review; `REVIEW_AUTO_HOLD_REPORTS` overrides. */
export const REVIEW_AUTO_HOLD_REPORTS_DEFAULT = 3;
/** Burst detection: this many unverified reviews on one listing within the window hold the next ones. */
export const REVIEW_BURST_THRESHOLD = 5;
export const REVIEW_BURST_WINDOW_MS = 3_600_000;
/** Spam filter: more links than this in a title + body holds the review. */
export const REVIEW_MAX_LINKS = 3;
export const REVIEW_TITLE_MAX = 120;
export const REVIEW_BODY_MAX = 5_000;
export const REPLY_BODY_MAX = 5_000;
export const REPORT_REASON_MAX = 2_000;
export const AUTHOR_NAME_MAX = 100;

export const reviewOrgDailyLimit = (): number => envInt('REVIEW_ORG_DAILY_LIMIT', REVIEW_ORG_DAILY_LIMIT_DEFAULT, { min: 1 });
export const reviewAutoHoldReports = (): number => envInt('REVIEW_AUTO_HOLD_REPORTS', REVIEW_AUTO_HOLD_REPORTS_DEFAULT, { min: 1 });

// -----------------------------------------------------------------------------
// Verified use: swappable for tests
// -----------------------------------------------------------------------------

export type VerifiedUseProbe = (orgId: string, publisher: string, name: string) => Promise<boolean>;
const liveProbe: VerifiedUseProbe = (orgId, publisher, name) => reportingService.hasVerifiedPluginUse(orgId, publisher, name);
let verifiedUseProbe: VerifiedUseProbe = liveProbe;

/** Test hook: replace the verified-use probe (nothing restores the live one). */
export function setVerifiedUseProbeForTests(p?: VerifiedUseProbe): void {
  verifiedUseProbe = p ?? liveProbe;
}

/** Whether the caller's org ran the listing successfully in the last 90 days. Fails closed (unverified). */
async function verifiedUse(caller: Caller, publisher: Publisher, listing: PluginListing): Promise<boolean> {
  try {
    return await verifiedUseProbe(caller.orgId, publisher.handle, listing.name);
  } catch {
    incCounter('ecosystem_review_verified_use_failed_total', {});
    return false;
  }
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------


export function replyView(r: PluginReviewReply, publisher: Pick<Publisher, 'displayName'>) {
  return { bodyHtml: r.bodyHtml, publisherDisplayName: publisher.displayName, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)! };
}

/** The AUTHOR's view of their own review (includes the markdown, the status and a removal reason). */
export function ownReviewView(r: PluginReview, reply: PluginReviewReply | null, publisher: Pick<Publisher, 'displayName'>) {
  return {
    id: r.id,
    rating: r.rating,
    title: r.title,
    bodyMd: r.bodyMd,
    bodyHtml: r.bodyHtml,
    version: r.version,
    status: r.status,
    verifiedUse: r.verifiedUse,
    helpfulCount: r.helpfulCount,
    moderationReason: r.status === 'removed' ? r.moderationReason : null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    reply: reply ? replyView(reply, publisher) : null,
  };
}

// -----------------------------------------------------------------------------
// Shared checks
// -----------------------------------------------------------------------------

function assertReviewsEnabled(): void {
  if (!isPluginReviewsEnabled()) {
    throw new EcosystemError(ErrorCode.PLUGIN_REVIEWS_DISABLED, 'Reviews are read-only on this instance right now.');
  }
}

/** Defence in depth behind the route's human-session gate. */
function assertPerson(caller: Caller): void {
  if (caller.principalType !== 'user') {
    throw new EcosystemError(ErrorCode.HUMAN_SESSION_REQUIRED, 'Reviews are written by people — API keys and service accounts cannot write, vote, report or reply.');
  }
}

/** The caller's org (or its root, for a team) owns the publisher. */
export function isOwnPublisher(caller: Caller, publisher: Pick<Publisher, 'ownerOrgId'>): boolean {
  const owner = publisher.ownerOrgId?.toLowerCase();
  return !!owner && (caller.orgId === owner || caller.parentOrgId === owner);
}

/** A reviewable (public) listing by handle/name, or 404. */
async function publicListing(handle: string, name: string): Promise<{ publisher: Publisher; listing: PluginListing }> {
  const publisher = await publishers.byHandle(handle);
  const listing = publisher ? await listings.byName(publisher.id, name) : null;
  if (!publisher || !listing || publisher.suspendedAt || !isActiveListing(listing) || listing.pausedAt) {
    throw new EcosystemError(ErrorCode.NOT_FOUND, `No listing ${handle}/${name}.`);
  }
  return { publisher, listing };
}

/** A review with its listing and publisher, or 404. */
export async function loadReview(id: string): Promise<{ review: PluginReview; listing: PluginListing; publisher: Publisher }> {
  const review = z.string().uuid().safeParse(id).success ? await reviews.byId(id) : null;
  const listing = review ? await listings.byId(review.listingId) : null;
  const publisher = listing ? await publishers.byId(listing.publisherId) : null;
  if (!review || !listing || !publisher) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Review not found.');
  return { review, listing, publisher };
}

/** The display name shown for the author: the username, never an email address. */
export function authorDisplayName(caller: Caller): string {
  const base = (caller.name ?? '').split('@')[0]!.trim();
  return (base || 'Pipeline Builder user').slice(0, AUTHOR_NAME_MAX);
}

function linkCount(...texts: Array<string | null | undefined>): number {
  return texts.reduce((n, t) => n + ((t ?? '').match(/https?:\/\/|www\./gi)?.length ?? 0), 0);
}

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

const optionalText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

const ReviewInput = z.object({
  rating: z.number().int().min(1).max(5),
  title: optionalText(REVIEW_TITLE_MAX),
  body: optionalText(REVIEW_BODY_MAX),
  version: z.union([z.string().trim().max(50), z.null()]).optional(),
}).strict();

const ReviewPatch = ReviewInput.partial().strict();

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/** A version the review may name: one the listing has published. */
async function versionOf(listing: PluginListing, requested: string | null | undefined): Promise<string | null> {
  if (requested === undefined) return listing.latestVersion ?? null;
  if (requested === null || requested === '') return null;
  if (!(await versions.get(listing.id, requested))) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `${requested} is not a published version of this plugin.`);
  }
  return requested;
}

/** The hold a new or edited review gets, if any. */
async function holdFor(listing: PluginListing, review: { title: string | null; bodyMd: string | null; verifiedUse: boolean }, isNew: boolean): Promise<ReviewHoldReason | null> {
  if (linkCount(review.title, review.bodyMd) > REVIEW_MAX_LINKS) return 'filter';
  if (isNew && !review.verifiedUse) {
    const since = new Date(Date.now() - REVIEW_BURST_WINDOW_MS);
    const recentUnverified = (await reviews.onListingSince(listing.id, since)).filter((r) => !r.verifiedUse).length;
    if (recentUnverified + 1 >= REVIEW_BURST_THRESHOLD) return 'burst';
  }
  return null;
}

async function announceHold(publisher: Publisher, listing: PluginListing, reason: ReviewHoldReason): Promise<void> {
  incCounter('ecosystem_review_holds_total', { reason });
  await notifyReviewHeld(publisher, listing, reason);
}

// -----------------------------------------------------------------------------
// The viewer's state
// -----------------------------------------------------------------------------

/** GET /plugins/listings/:publisher/:name/review-state — what the signed-in viewer may do here. */
export async function reviewState(caller: Caller, handle: string, name: string) {
  const { publisher, listing } = await publicListing(handle, name);
  const [mine, all, verified] = await Promise.all([
    reviews.byAuthor(listing.id, caller.userId),
    reviews.forListing(listing.id),
    verifiedUse(caller, publisher, listing),
  ]);
  const ids = all.map((r) => r.id);
  const [helpful, reported, reply] = await Promise.all([
    votes.votedBy(caller.userId, ids),
    reports.reportedBy(caller.userId, ids),
    mine ? replies.byReview(mine.id) : Promise.resolve(null),
  ]);
  const enabled = isPluginReviewsEnabled();
  const own = isOwnPublisher(caller, publisher);
  const person = caller.principalType === 'user';
  const blocked = !enabled ? 'reviews_disabled' : !person ? 'machine_credential' : own ? 'own_publisher' : null;
  return {
    myReview: mine ? ownReviewView(mine, reply, publisher) : null,
    helpfulReviewIds: helpful,
    reportedReviewIds: reported,
    canReview: blocked === null,
    reviewBlockedReason: blocked,
    canReply: enabled && person && !!publisher.ownerOrgId && caller.orgId === publisher.ownerOrgId.toLowerCase() && can(caller, 'publishers:manage'),
    verifiedUse: verified,
  };
}

// -----------------------------------------------------------------------------
// Write / edit / delete
// -----------------------------------------------------------------------------

/** POST /plugins/listings/:publisher/:name/reviews */
export async function createReview(caller: Caller, handle: string, name: string, body: unknown) {
  assertReviewsEnabled();
  assertPerson(caller);
  const input = parse(ReviewInput, body);
  const { publisher, listing } = await publicListing(handle, name);
  if (isOwnPublisher(caller, publisher)) {
    throw new EcosystemError(ErrorCode.REVIEW_SELF_PROMOTION, 'You can\'t review your own organization\'s plugins.');
  }
  if (await reviews.byAuthor(listing.id, caller.userId)) {
    throw new EcosystemError(ErrorCode.DUPLICATE_ENTRY, 'You already reviewed this plugin — edit your review instead.');
  }
  const limit = reviewOrgDailyLimit();
  if (await reviews.countByOrgSince(caller.orgId, new Date(Date.now() - DAY_MS)) >= limit) {
    throw new EcosystemError(ErrorCode.RATE_LIMIT_EXCEEDED, `Your organization reached its limit of ${limit} new reviews a day.`, { reason: 'org_daily_limit', limit });
  }
  const version = await versionOf(listing, input.version);
  const bodyMd = input.body ?? null;
  const verified = await verifiedUse(caller, publisher, listing);
  const hold = await holdFor(listing, { title: input.title ?? null, bodyMd, verifiedUse: verified }, true);

  const review = await reviews.insert({
    listingId: listing.id,
    version,
    rating: input.rating,
    title: input.title ?? null,
    bodyMd,
    bodyHtml: bodyMd ? renderUntrustedMarkdown(bodyMd) : null,
    authorUserId: caller.userId,
    authorOrgId: caller.orgId,
    authorDisplayName: authorDisplayName(caller),
    verifiedUse: verified,
    status: hold ? 'held' : 'published',
    holdReason: hold,
  });
  ecosystemAudit({
    action: 'plugin.review.create',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID,
    targetType: 'plugin_review',
    targetId: review.id,
    details: {
      listing: `${publisher.handle}/${listing.name}`, rating: review.rating, version, verifiedUse: verified, ...(hold ? { held: hold } : {}),
    },
  });
  if (hold) {
    await announceHold(publisher, listing, hold);
  } else {
    await notifyReviewPosted(publisher, listing, review, false);
    await refreshListingRating(listing.id);
  }
  return { review: ownReviewView(review, null, publisher) };
}

/** PATCH /plugins/reviews/:id — the author edits; the prior text goes to history. */
export async function updateReview(caller: Caller, id: string, body: unknown) {
  assertReviewsEnabled();
  assertPerson(caller);
  const patch = parse(ReviewPatch, body);
  const { review, listing, publisher } = await loadReview(id);
  if (review.authorUserId !== caller.userId) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Review not found.');
  if (review.status === 'removed') throw new EcosystemError(ErrorCode.CONFLICT, 'A removed review can\'t be edited.');

  const next = {
    rating: patch.rating ?? review.rating,
    title: patch.title !== undefined ? patch.title : review.title,
    bodyMd: patch.body !== undefined ? patch.body : review.bodyMd,
    version: patch.version !== undefined ? await versionOf(listing, patch.version) : review.version,
  };
  const changed = (['rating', 'title', 'bodyMd', 'version'] as const).filter((k) => next[k] !== review[k]);
  const reply = await replies.byReview(review.id);
  if (changed.length === 0) return { review: ownReviewView(review, reply, publisher) };

  await reviewHistory.append({ reviewId: review.id, version: review.version, rating: review.rating, title: review.title, bodyMd: review.bodyMd });
  const verified = await verifiedUse(caller, publisher, listing);
  // An edit can trip the link filter; it never lifts an existing hold.
  const hold = review.status === 'published' ? await holdFor(listing, { title: next.title, bodyMd: next.bodyMd, verifiedUse: verified }, false) : null;
  const updated = (await reviews.update(review.id, {
    ...next,
    bodyHtml: next.bodyMd ? renderUntrustedMarkdown(next.bodyMd) : null,
    verifiedUse: verified,
    authorDisplayName: authorDisplayName(caller),
    ...(hold ? { status: 'held' as const, holdReason: hold } : {}),
  }))!;
  ecosystemAudit({
    action: 'plugin.review.update',
    actor: actorId({ userId: caller.userId }),
    orgId: caller.orgId,
    affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID,
    targetType: 'plugin_review',
    targetId: review.id,
    details: {
      listing: `${publisher.handle}/${listing.name}`, rating: updated.rating, changed, verifiedUse: verified, ...(hold ? { held: hold } : {}),
    },
  });
  if (hold) await announceHold(publisher, listing, hold);
  else if (updated.status === 'published') await notifyReviewPosted(publisher, listing, updated, true);
  await refreshListingRating(listing.id);
  return { review: ownReviewView(updated, reply, publisher) };
}

/** DELETE /plugins/reviews/:id — the author deletes (reply, votes, reports and history go with it). */
export async function deleteReview(caller: Caller, id: string) {
  assertReviewsEnabled();
  assertPerson(caller);
  const { review, listing, publisher } = await loadReview(id);
  if (review.authorUserId !== caller.userId) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Review not found.');
  await reviews.remove(review.id);
  ecosystemAudit({ action: 'plugin.review.delete', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}`, rating: review.rating } });
  await refreshListingRating(listing.id);
  return { deleted: true };
}

// -----------------------------------------------------------------------------
// Helpful votes (not audited by design)
// -----------------------------------------------------------------------------

/** PUT / DELETE /plugins/reviews/:id/helpful — one vote per user; not on your own review or your own org's listing. */
export async function setHelpful(caller: Caller, id: string, helpful: boolean) {
  assertReviewsEnabled();
  assertPerson(caller);
  const { review, publisher } = await loadReview(id);
  if (review.status !== 'published') throw new EcosystemError(ErrorCode.NOT_FOUND, 'Review not found.');
  if (review.authorUserId === caller.userId) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'You can\'t vote on your own review.');
  if (isOwnPublisher(caller, publisher)) {
    throw new EcosystemError(ErrorCode.REVIEW_SELF_PROMOTION, 'You can\'t vote on reviews of your own organization\'s plugins.');
  }
  const has = await votes.has(review.id, caller.userId);
  if (helpful && !has) await votes.add(review.id, caller.userId);
  if (!helpful && has) await votes.remove(review.id, caller.userId);
  const helpfulCount = await votes.count(review.id);
  if (helpfulCount !== review.helpfulCount) await reviews.setHelpfulCount(review.id, helpfulCount);
  return { helpfulCount, voted: helpful };
}

// -----------------------------------------------------------------------------
// Reports
// -----------------------------------------------------------------------------

const ReportInput = z.object({
  category: z.enum(REVIEW_REPORT_CATEGORIES as unknown as [ReviewReportCategory, ...ReviewReportCategory[]]),
  reason: optionalText(REPORT_REASON_MAX),
}).strict();

/**
 * POST /plugins/reviews/:id/report. A `security` report holds the review at
 * once, notifies privately (N19) and opens the advisory draft through the
 * hook; other reports hold it once {@link reviewAutoHoldReports} distinct
 * people reported it (N17). The reporter never learns whether it was held.
 */
export async function reportReview(caller: Caller, id: string, body: unknown) {
  assertReviewsEnabled();
  assertPerson(caller);
  const input = parse(ReportInput, body);
  const { review, listing, publisher } = await loadReview(id);
  if (review.status === 'removed') throw new EcosystemError(ErrorCode.NOT_FOUND, 'Review not found.');
  if (review.authorUserId === caller.userId) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'You can\'t report your own review.');
  if (await reports.byReporter(review.id, caller.userId)) {
    throw new EcosystemError(ErrorCode.DUPLICATE_ENTRY, 'You already reported this review.');
  }
  const report = await reports.insert({ reviewId: review.id, reporterUserId: caller.userId, category: input.category, reason: input.reason ?? null });
  const ref = `${publisher.handle}/${listing.name}`;
  // Never the report's text: it can carry exploit details.
  ecosystemAudit({ action: 'plugin.review.report', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: ref, category: input.category } });

  let hold: ReviewHoldReason | null = null;
  if (input.category === 'security') {
    hold = 'security';
  } else if (review.status === 'published') {
    const open = (await reports.forReviews([review.id])).filter((r) => r.resolvedAt === null);
    if (new Set(open.map((r) => r.reporterUserId)).size >= reviewAutoHoldReports()) hold = 'reports';
  }
  if (hold && review.status === 'published') {
    await reviews.update(review.id, { status: 'held', holdReason: hold });
    ecosystemAudit({ action: 'plugin.review.hold', actor: SYSTEM_ACTOR_ID, affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: ref, reason: hold, trigger: input.category === 'security' ? 'security_report' : 'reports' } });
    await refreshListingRating(listing.id);
    if (hold !== 'security') await announceHold(publisher, listing, hold);
    else incCounter('ecosystem_review_holds_total', { reason: hold });
  }
  if (input.category === 'security') {
    await notifySecurityReport(publisher, listing, review.version, input.reason ?? null);
    // The private advisory draft. Never fails the report: the report is stored,
    // the review held and N19 sent regardless; a missing draft is counted and
    // a moderator can open one by hand from the queue.
    try {
      await openReviewAdvisoryDraft({ reviewId: review.id, reportId: report.id, listingId: listing.id, version: review.version, details: input.reason ?? null });
      incCounter('ecosystem_review_security_reports_total', { outcome: 'handled' });
    } catch (err) {
      incCounter('ecosystem_review_security_reports_total', { outcome: 'failed' });
      logger.warn('Advisory draft for a security report failed', { reviewId: review.id, error: errorMessage(err) });
    }
  }
  return { reported: true };
}

// -----------------------------------------------------------------------------
// Publisher reply
// -----------------------------------------------------------------------------

const ReplyInput = z.object({ body: z.string().trim().min(1).max(REPLY_BODY_MAX) }).strict();

/** The review, when the caller manages its listing's publisher (its own org, `publishers:manage`). */
async function replyTarget(caller: Caller, id: string) {
  const loaded = await loadReview(id);
  if (loaded.review.status !== 'published') throw new EcosystemError(ErrorCode.NOT_FOUND, 'Review not found.');
  const owner = loaded.publisher.ownerOrgId?.toLowerCase();
  if (!owner || caller.orgId !== owner || !can(caller, 'publishers:manage')) {
    throw new EcosystemError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Only the publisher\'s managers can reply to its reviews.');
  }
  return loaded;
}

/** PUT /plugins/reviews/:id/reply — create or edit the one public reply. */
export async function putReply(caller: Caller, id: string, body: unknown) {
  assertReviewsEnabled();
  assertPerson(caller);
  const input = parse(ReplyInput, body);
  const { review, listing, publisher } = await replyTarget(caller, id);
  const values = { bodyMd: input.body, bodyHtml: renderUntrustedMarkdown(input.body), authorUserId: caller.userId };
  const existing = await replies.byReview(review.id);
  const reply = existing
    ? (await replies.update(review.id, values))!
    : await replies.insert({ reviewId: review.id, publisherId: publisher.id, ...values });
  ecosystemAudit({ action: existing ? 'plugin.review.reply.update' : 'plugin.review.reply.create', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}` } });
  if (!existing) await notifyReplied(publisher, listing, review);
  return { reply: { ...replyView(reply, publisher), bodyMd: reply.bodyMd } };
}

/** DELETE /plugins/reviews/:id/reply */
export async function deleteReply(caller: Caller, id: string) {
  assertReviewsEnabled();
  assertPerson(caller);
  const { review, listing, publisher } = await replyTarget(caller, id);
  if (!(await replies.remove(review.id))) throw new EcosystemError(ErrorCode.NOT_FOUND, 'This review has no reply.');
  ecosystemAudit({ action: 'plugin.review.reply.delete', actor: actorId({ userId: caller.userId }), orgId: caller.orgId, affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}` } });
  return { deleted: true };
}
