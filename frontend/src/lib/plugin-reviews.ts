// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Labels, limits and error copy for plugin reviews. */
import type { BadgeColor } from '@/components/ui/Badge';
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
  read_only_session: 'This is a read-only session, so it can\u2019t post a review.',
};

export const REPORT_CATEGORY_LABELS: Record<ReviewReportCategory, string> = {
  spam: 'Spam or advertising',
  abuse: 'Abusive or harassing',
  off_topic: 'Off topic',
  security: 'Security issue',
};

export const HOLD_REASON_LABELS: Record<ReviewHoldReason, string> = {
  reports: 'Reported by users',
  burst: 'Burst of new-account reviews',
  filter: 'Content filter',
  security: 'Security report',
  moderator: 'Held by a moderator',
};

/** Every review status: its words and badge colour, in one place. */
export const REVIEW_STATUS = {
  published: { label: 'Published', color: 'green' },
  held: { label: 'Awaiting moderation', color: 'yellow' },
  removed: { label: 'Removed', color: 'red' },
} as const satisfies Record<ReviewStatus, { label: string; color: BadgeColor }>;

const reviewStatusEntries = Object.entries(REVIEW_STATUS) as Array<[ReviewStatus, (typeof REVIEW_STATUS)[ReviewStatus]]>;

export const REVIEW_STATUS_LABELS = Object.fromEntries(
  reviewStatusEntries.map(([status, meta]) => [status, meta.label]),
) as Record<ReviewStatus, string>;

export const REVIEW_STATUS_COLORS = Object.fromEntries(
  reviewStatusEntries.map(([status, meta]) => [status, meta.color]),
) as Record<ReviewStatus, BadgeColor>;

/** "4 stars" / "1 star". */
export function starsLabel(n: number): string {
  return `${n} star${n === 1 ? '' : 's'}`;
}

/** The review API's error codes, in words a reviewer can act on. */
const REVIEW_ERROR_COPY = {
  DUPLICATE_ENTRY: "You've already reviewed this plugin. Edit your review instead.",
  REVIEW_SELF_PROMOTION: REVIEW_BLOCKED_COPY.own_publisher,
  PLUGIN_REVIEWS_DISABLED: REVIEW_BLOCKED_COPY.reviews_disabled,
  HUMAN_SESSION_REQUIRED: REVIEW_BLOCKED_COPY.machine_credential,
  RATE_LIMIT_EXCEEDED: 'Too many reviews from your organization or network today. Try again later.',
  CONFLICT: 'This review was removed by a moderator and can no longer be edited.',
} as const satisfies Record<string, string>;

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
    if (err.code && Object.hasOwn(REVIEW_ERROR_COPY, err.code)) {
      return REVIEW_ERROR_COPY[err.code as keyof typeof REVIEW_ERROR_COPY];
    }
  }
  return formatError(err, fallback);
}
