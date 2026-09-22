// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Labels, limits and error copy for plugin reviews (plan §5, W4). */
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import type {
  ReviewBlockedReason, ReviewHoldReason, ReviewReportCategory, ReviewStatus,
} from '@/types/plugin-reviews';

export const REVIEW_TITLE_MAX = 120;
export const REVIEW_BODY_MAX = 5000;
export const REPLY_BODY_MAX = 5000;
export const REPORT_REASON_MAX = 2000;

export const REVIEW_BLOCKED_COPY: Record<ReviewBlockedReason, string> = {
  own_publisher: "You can't review your own organization's plugins.",
  reviews_disabled: 'Reviews are read-only right now.',
  machine_credential: 'Sign in as a person to write a review.',
};

export const REPORT_CATEGORY_LABELS: Record<ReviewReportCategory, string> = {
  spam: 'Spam or advertising',
  abuse: 'Abusive or harassing',
  off_topic: 'Off topic',
  security: 'Security issue',
};

export const REPORT_CATEGORIES = Object.keys(REPORT_CATEGORY_LABELS) as ReviewReportCategory[];

export const HOLD_REASON_LABELS: Record<ReviewHoldReason, string> = {
  reports: 'Reported by users',
  burst: 'Burst of new-account reviews',
  filter: 'Content filter',
  security: 'Security report',
  moderator: 'Held by a moderator',
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  published: 'Published',
  held: 'Awaiting moderation',
  removed: 'Removed',
};

export const REVIEW_STATUS_COLORS: Record<ReviewStatus, 'green' | 'yellow' | 'red'> = {
  published: 'green',
  held: 'yellow',
  removed: 'red',
};

/** "4 stars" / "1 star". */
export function starsLabel(n: number): string {
  return `${n} star${n === 1 ? '' : 's'}`;
}

/**
 * The review API's error codes in words a reviewer can act on; anything else
 * keeps the server's message. `overrides` re-words a code for one call site
 * (DUPLICATE_ENTRY means "already reviewed" on create, "already reported" on report).
 */
export function reviewErrorMessage(
  err: unknown,
  fallback = 'Something went wrong',
  overrides: Partial<Record<string, string>> = {},
): string {
  if (err instanceof ApiError) {
    const override = err.code ? overrides[err.code] : undefined;
    if (override) return override;
    switch (err.code) {
      case 'DUPLICATE_ENTRY': return "You've already reviewed this plugin. Edit your review instead.";
      case 'REVIEW_SELF_PROMOTION': return REVIEW_BLOCKED_COPY.own_publisher;
      case 'PLUGIN_REVIEWS_DISABLED': return REVIEW_BLOCKED_COPY.reviews_disabled;
      case 'HUMAN_SESSION_REQUIRED': return REVIEW_BLOCKED_COPY.machine_credential;
      case 'RATE_LIMIT_EXCEEDED': return 'Too many reviews from your organization or network today. Try again later.';
      case 'CONFLICT': return 'This review was removed by a moderator and can no longer be edited.';
      default: break;
    }
  }
  return formatError(err, fallback);
}
