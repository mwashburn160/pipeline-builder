// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The seam between review reports and security advisories
 * (docs/plans/plugin-ecosystem.md §5 "Security reports", N19, W8).
 *
 * A report with `category: 'security'` never posts publicly: the review
 * service holds the review, notifies the publisher's managers and the
 * moderators privately (N19), and hands the report to the handler registered
 * here, which opens the PRIVATE advisory draft (`plugin_advisories` with
 * `source = 'review'`). The advisory workstream (W8) owns that handler and
 * registers it once at boot with {@link setReviewSecurityReportHandler}.
 *
 * Dispatch never throws into the report route: without a handler, or when it
 * fails, the report is still stored, the review still held and N19 still sent
 * — the outcome is logged and counted
 * (`ecosystem_review_security_reports_total{outcome}`), so a missing draft is
 * visible and a moderator can open one by hand from the queue.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';

const logger = createLogger('ecosystem-review-hooks');

/** What the advisory path receives for a security report on a review. */
export interface ReviewSecurityReport {
  reviewId: string;
  reportId: string;
  listingId: string;
  publisherId: string;
  /** The publisher's org (the advisory's `affectedOrgId`); null for the platform-owned `community` publisher. */
  publisherOrgId: string | null;
  publisherHandle: string;
  listingName: string;
  /** The version the review is about (the draft's starting affected range), when known. */
  version: string | null;
  /** The reporter's free-text details (private: never shown on the public page). */
  details: string | null;
  /** Who reported, for the draft's `createdBy` and audit. Never shown to the publisher. */
  reportedBy: { userId: string; orgId: string };
  reportedAt: Date;
}

export type ReviewSecurityReportHandler = (report: ReviewSecurityReport) => Promise<void>;

let handler: ReviewSecurityReportHandler | null = null;

/** Register (or, with null, clear) the advisory path's handler. One handler; the last registration wins. */
export function setReviewSecurityReportHandler(h: ReviewSecurityReportHandler | null): void {
  handler = h;
}

/** Hand a security report to the advisory path. Never throws. */
export async function dispatchReviewSecurityReport(report: ReviewSecurityReport): Promise<'handled' | 'unhandled' | 'failed'> {
  if (!handler) {
    incCounter('ecosystem_review_security_reports_total', { outcome: 'unhandled' });
    logger.warn('Security report on a review has no advisory handler; open a draft by hand', { reviewId: report.reviewId, listingId: report.listingId });
    return 'unhandled';
  }
  try {
    await handler(report);
    incCounter('ecosystem_review_security_reports_total', { outcome: 'handled' });
    return 'handled';
  } catch (err) {
    incCounter('ecosystem_review_security_reports_total', { outcome: 'failed' });
    logger.warn('Advisory draft for a security report failed', { reviewId: report.reviewId, error: errorMessage(err) });
    return 'failed';
  }
}
