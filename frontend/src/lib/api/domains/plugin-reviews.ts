// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse } from '@/types';
import type { ReviewReply } from '@/lib/public-directory/types';
import type {
  ModerationReview, OwnReview, ReviewBody, ReviewModerationQueue, ReviewReportCategory, ReviewState,
} from '@/types/plugin-reviews';

const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/**
 * Plugin reviews (plugin service, docs/plans/plugin-ecosystem.md §5, W4).
 *
 * Reading published reviews is anonymous (`@/lib/public-directory/api`). The
 * writes here need `plugins:read` AND a human session (a machine credential
 * gets `HUMAN_SESSION_REQUIRED`); replies need the listing's publisher. The
 * console half (`/plugins/ecosystem/reviews*`) is system-org `plugins:moderate`
 * on an aal2 session.
 */
export function pluginReviewsApi(core: ApiCore) {
  return {
    // ── Viewer ────────────────────────────────────────────────────────────
    /** The viewer's own review, votes and reports, and whether they may review / reply. */
    getReviewState: async (publisher: string, name: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<ReviewState>>(`/api/plugins/listings/${enc(publisher)}/${enc(name)}/review-state`, { signal: opts?.signal }),

    /** 201. One review per user per listing: a second is 409 `DUPLICATE_ENTRY`. */
    createReview: async (publisher: string, name: string, body: ReviewBody) =>
      core.request<ApiResponse<{ review: OwnReview }>>(`/api/plugins/listings/${enc(publisher)}/${enc(name)}/reviews`, { method: 'POST', ...json(body) }),

    /** Author only; a removed review is 409 `CONFLICT`. */
    updateReview: async (id: string, body: Partial<ReviewBody>) =>
      core.request<ApiResponse<{ review: OwnReview }>>(`/api/plugins/reviews/${enc(id)}`, { method: 'PATCH', ...json(body) }),

    deleteReview: async (id: string) =>
      core.request<ApiResponse<{ deleted: true }>>(`/api/plugins/reviews/${enc(id)}`, { method: 'DELETE' }),

    /** One "helpful" vote per user; not on your own review. */
    voteReviewHelpful: async (id: string) =>
      core.request<ApiResponse<{ helpfulCount: number; voted: true }>>(`/api/plugins/reviews/${enc(id)}/helpful`, { method: 'PUT' }),

    unvoteReviewHelpful: async (id: string) =>
      core.request<ApiResponse<{ helpfulCount: number; voted: false }>>(`/api/plugins/reviews/${enc(id)}/helpful`, { method: 'DELETE' }),

    /** A `security` report never posts publicly; it goes to the publisher and the moderators. */
    reportReview: async (id: string, category: ReviewReportCategory, reason?: string) =>
      core.request<ApiResponse<{ reported: true }>>(`/api/plugins/reviews/${enc(id)}/report`, {
        method: 'POST',
        ...json(reason ? { category, reason } : { category }),
      }),

    /** The publisher's one public response (create or replace). */
    putReviewReply: async (id: string, body: string) =>
      core.request<ApiResponse<{ reply: ReviewReply & { bodyMd: string } }>>(`/api/plugins/reviews/${enc(id)}/reply`, { method: 'PUT', ...json({ body }) }),

    deleteReviewReply: async (id: string) =>
      core.request<ApiResponse<{ deleted: true }>>(`/api/plugins/reviews/${enc(id)}/reply`, { method: 'DELETE' }),

    // ── Ecosystem console: moderation queue ───────────────────────────────
    /** `open` = held + reported; `removed` = taken down. */
    listModerationReviews: async (params?: { queue?: ReviewModerationQueue }, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ reviews: ModerationReview[] }>>(
        `/api/plugins/ecosystem/reviews${buildQuery(params)}`,
        { signal: opts?.signal },
      ),

    holdReview: async (id: string, reason: string) =>
      core.request<ApiResponse<{ review: ModerationReview }>>(`/api/plugins/ecosystem/reviews/${enc(id)}/hold`, { method: 'POST', ...json({ reason }) }),

    releaseReview: async (id: string, note?: string) =>
      core.request<ApiResponse<{ review: ModerationReview }>>(`/api/plugins/ecosystem/reviews/${enc(id)}/release`, {
        method: 'POST',
        ...json(note ? { note } : {}),
      }),

    removeReview: async (id: string, reason: string) =>
      core.request<ApiResponse<{ review: ModerationReview }>>(`/api/plugins/ecosystem/reviews/${enc(id)}/remove`, { method: 'POST', ...json({ reason }) }),

    removeReviewReply: async (id: string, reason: string) =>
      core.request<ApiResponse<{ review: ModerationReview }>>(`/api/plugins/ecosystem/reviews/${enc(id)}/remove-reply`, { method: 'POST', ...json({ reason }) }),
  };
}
