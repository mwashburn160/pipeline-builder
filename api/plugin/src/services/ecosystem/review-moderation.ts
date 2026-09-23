// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The review half of the Ecosystem console's moderation queue
 * (docs/plugin-publishing.md `plugins:moderate`, N17/N18): held
 * reviews and reviews with open reports, and the four decisions — hold,
 * release, remove, remove the publisher's reply. Reached only through
 * `requireEcosystemPermission('plugins:moderate')` (system org + aal2).
 *
 * Every decision is audited with `orgId` = the system org and `affectedOrgId`
 * = the publisher's org, resolves the review's open reports once it is
 * released or removed, and refreshes the listing's rating (a hold or removal
 * takes the review out of the score; a release puts it back).
 */

import { isoOrNull, actorId, ErrorCode, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { PluginListing, PluginReview, PluginReviewReply, PluginReviewReport, Publisher } from '@pipeline-builder/pipeline-data';
import { z } from 'zod';

import { ecosystemAudit } from './audit.js';
import { EcosystemError, type Caller } from './context.js';
import { notifyReviewPosted, notifyReviewRemoved } from './review-notify.js';
import { replies, reports, reviews } from './reviews-store.js';
import { loadReview, replyView } from './reviews.js';
import { refreshListingRating } from './stats.js';
import { listings, publishers } from './store.js';

/** How many items one queue page holds. */
export const REVIEW_QUEUE_LIMIT = 200;


function moderationView(
  r: PluginReview,
  listing: PluginListing | null,
  publisher: Publisher | null,
  reviewReports: PluginReviewReport[],
  reply: PluginReviewReply | null,
) {
  return {
    id: r.id,
    listing: { id: r.listingId, publisher: publisher?.handle ?? '', name: listing?.name ?? '' },
    rating: r.rating,
    title: r.title,
    bodyHtml: r.bodyHtml,
    version: r.version,
    // Moderators see who wrote it (to spot rings); never the author's org.
    author: { userId: r.authorUserId, displayName: r.authorDisplayName },
    verifiedUse: r.verifiedUse,
    status: r.status,
    holdReason: r.holdReason,
    moderationReason: r.moderationReason,
    helpfulCount: r.helpfulCount,
    openReportCount: reviewReports.filter((p) => p.resolvedAt === null).length,
    reports: reviewReports.map((p) => ({ category: p.category, reason: p.reason, createdAt: isoOrNull(p.createdAt)!, resolved: p.resolvedAt !== null })),
    reply: reply && publisher ? replyView(reply, publisher) : null,
    createdAt: isoOrNull(r.createdAt)!,
    updatedAt: isoOrNull(r.updatedAt)!,
  };
}
export type ModerationReviewView = ReturnType<typeof moderationView>;

/** Views for these reviews, loading their listings, publishers, reports and replies in bulk. */
async function views(rows: PluginReview[]): Promise<ModerationReviewView[]> {
  const ids = rows.map((r) => r.id);
  const [allReports, allReplies, allListings] = await Promise.all([
    reports.forReviews(ids),
    replies.byReviews(ids),
    listings.byIds([...new Set(rows.map((r) => r.listingId))]),
  ]);
  const listingBy = new Map(allListings.map((l) => [l.id, l]));
  const publisherBy = new Map((await publishers.byIds([...new Set(allListings.map((l) => l.publisherId))])).map((p) => [p.id, p]));
  return rows.map((r) => {
    const listing = listingBy.get(r.listingId) ?? null;
    return moderationView(
      r,
      listing,
      listing ? publisherBy.get(listing.publisherId) ?? null : null,
      allReports.filter((p) => p.reviewId === r.id),
      allReplies.find((p) => p.reviewId === r.id) ?? null,
    );
  });
}

/**
 * GET /plugins/ecosystem/reviews — `queue=open` (default): held reviews plus
 * any review with an unresolved report; `queue=removed`: removed reviews.
 * Newest activity first.
 */
export async function reviewQueue(query: Record<string, unknown>): Promise<{ reviews: ModerationReviewView[] }> {
  if (query.queue === 'removed') {
    return { reviews: await views(await reviews.withStatus(['removed'], REVIEW_QUEUE_LIMIT)) };
  }
  const held = await reviews.withStatus(['held'], REVIEW_QUEUE_LIMIT);
  const reportedIds = [...new Set((await reports.open()).map((p) => p.reviewId))].filter((id) => !held.some((r) => r.id === id));
  const reported = (await reviews.byIds(reportedIds)).filter((r) => r.status === 'published');
  const rows = [...held, ...reported]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, REVIEW_QUEUE_LIMIT);
  return { reviews: await views(rows) };
}

/** The console overview's review counts: held, and published-but-reported. */
export async function reviewQueueCounts(): Promise<{ held: number; reported: number }> {
  const held = await reviews.withStatus(['held']);
  const heldIds = new Set(held.map((r) => r.id));
  const reportedIds = [...new Set((await reports.open()).map((p) => p.reviewId))].filter((id) => !heldIds.has(id));
  const reported = (await reviews.byIds(reportedIds)).filter((r) => r.status === 'published');
  return { held: held.length, reported: reported.length };
}

const Reason = z.string().trim().min(1).max(1000);

function reasonOf(body: Record<string, unknown>, key: 'reason' | 'note', required: boolean): string | null {
  const raw = body[key];
  if (!required && (raw === undefined || raw === null || raw === '')) return null;
  const parsed = Reason.safeParse(raw);
  if (!parsed.success) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, `${key} is required`);
  return parsed.data;
}

async function viewOf(id: string): Promise<{ review: ModerationReviewView }> {
  const row = await reviews.byId(id);
  return { review: (await views([row!]))[0]! };
}

/** POST /plugins/ecosystem/reviews/:id/hold — take a published review out of the directory. */
export async function holdReview(moderator: Caller, id: string, body: Record<string, unknown>) {
  const reason = reasonOf(body, 'reason', true)!;
  const { review, listing, publisher } = await loadReview(id);
  if (review.status !== 'published') throw new EcosystemError(ErrorCode.CONFLICT, `The review is ${review.status}, not published.`);
  await reviews.update(review.id, { status: 'held', holdReason: 'moderator', moderationReason: reason });
  ecosystemAudit({ action: 'plugin.review.hold', actor: actorId({ userId: moderator.userId }), affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}`, reason: 'moderator' } });
  await refreshListingRating(listing.id);
  return viewOf(review.id);
}

/**
 * POST /plugins/ecosystem/reviews/:id/release — publish a held review (or
 * clear the reports on a published one). Its open reports are resolved; a
 * review that becomes visible is announced to the publisher (N15).
 */
export async function releaseReview(moderator: Caller, id: string, body: Record<string, unknown>) {
  const note = reasonOf(body, 'note', false);
  const { review, listing, publisher } = await loadReview(id);
  if (review.status === 'removed') throw new EcosystemError(ErrorCode.CONFLICT, 'A removed review can\'t be released.');
  const wasHeld = review.status === 'held';
  const updated = (await reviews.update(review.id, { status: 'published', holdReason: null, moderationReason: null }))!;
  await reports.resolve(review.id);
  ecosystemAudit({ action: 'plugin.review.release', actor: actorId({ userId: moderator.userId }), affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}`, from: review.status, heldFor: review.holdReason, ...(note ? { note } : {}) } });
  if (wasHeld) {
    await refreshListingRating(listing.id);
    await notifyReviewPosted(publisher, listing, updated, false);
  }
  return viewOf(review.id);
}

/** POST /plugins/ecosystem/reviews/:id/remove — remove for good; the author is told why (N18). */
export async function removeReview(moderator: Caller, id: string, body: Record<string, unknown>) {
  const reason = reasonOf(body, 'reason', true)!;
  const { review, listing, publisher } = await loadReview(id);
  if (review.status === 'removed') throw new EcosystemError(ErrorCode.CONFLICT, 'The review is already removed.');
  await reviews.update(review.id, { status: 'removed', holdReason: null, moderationReason: reason });
  await reports.resolve(review.id);
  ecosystemAudit({ action: 'plugin.review.remove', actor: actorId({ userId: moderator.userId }), affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}`, from: review.status } });
  await refreshListingRating(listing.id);
  await notifyReviewRemoved(publisher, listing, review, reason);
  return viewOf(review.id);
}

/** POST /plugins/ecosystem/reviews/:id/remove-reply — replies are moderated like reviews. */
export async function removeReply(moderator: Caller, id: string, body: Record<string, unknown>) {
  reasonOf(body, 'reason', true);
  const { review, listing, publisher } = await loadReview(id);
  if (!(await replies.remove(review.id))) throw new EcosystemError(ErrorCode.NOT_FOUND, 'This review has no reply.');
  ecosystemAudit({ action: 'plugin.review.reply.delete', actor: actorId({ userId: moderator.userId }), affectedOrgId: publisher.ownerOrgId ?? SYSTEM_ORG_ID, targetType: 'plugin_review', targetId: review.id, details: { listing: `${publisher.handle}/${listing.name}`, by: 'moderator' } });
  return viewOf(review.id);
}
