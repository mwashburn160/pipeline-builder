// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin reviews and ratings (docs/plans/plugin-ecosystem.md §5 — workstream
 * W4). Mirrors the plugin service's authenticated review routes and the
 * Ecosystem console's moderation queue. The public (anonymous) shapes live in
 * `@/lib/public-directory/types`.
 *
 * Every `bodyHtml` is rendered and sanitized SERVER-side; `bodyMd` is only the
 * author's own source text, for pre-filling an edit form — never rendered.
 */

import type { ReviewReply } from '@/lib/public-directory/types';

export type ReviewStatus = 'published' | 'held' | 'removed';
export type ReviewBlockedReason = 'own_publisher' | 'reviews_disabled' | 'machine_credential';
export type ReviewReportCategory = 'spam' | 'abuse' | 'off_topic' | 'security';
export type ReviewHoldReason = 'reports' | 'burst' | 'filter' | 'security' | 'moderator';
export type ReviewModerationQueue = 'open' | 'removed';

/** The viewer's own review of a listing, in any status. */
export interface OwnReview {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string | null;
  bodyHtml: string | null;
  version: string | null;
  status: ReviewStatus;
  verifiedUse: boolean;
  helpfulCount: number;
  /** Why a moderator held or removed it. */
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
  reply: ReviewReply | null;
}

/** `GET /plugins/listings/:publisher/:name/review-state`. */
export interface ReviewState {
  myReview: OwnReview | null;
  helpfulReviewIds: string[];
  reportedReviewIds: string[];
  canReview: boolean;
  reviewBlockedReason: ReviewBlockedReason | null;
  /** The viewer manages the listing's publisher and may reply. */
  canReply: boolean;
  /** The viewer's org ran the plugin recently — a new review carries the badge. */
  verifiedUse: boolean;
}

export interface ReviewBody {
  rating: number;
  title?: string;
  body?: string;
  version?: string;
}

/** One review in the Ecosystem console's moderation queue. */
export interface ModerationReview {
  id: string;
  listing: { id: string; publisher: string; name: string };
  rating: number;
  title: string | null;
  bodyHtml: string | null;
  version: string | null;
  author: { userId: string | null; displayName: string | null };
  verifiedUse: boolean;
  status: ReviewStatus;
  holdReason: ReviewHoldReason | null;
  moderationReason: string | null;
  helpfulCount: number;
  openReportCount: number;
  reports: Array<{ category: ReviewReportCategory; reason: string | null; createdAt: string; resolved: boolean }>;
  reply: ReviewReply | null;
  createdAt: string;
  updatedAt: string;
}
