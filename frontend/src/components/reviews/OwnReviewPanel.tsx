// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { formatDay } from '@/components/public-directory/ListingCardView';
import { READ_ONLY_REASON } from '@/components/ui/ReadOnlyNotice';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { REVIEW_STATUS_COLORS, REVIEW_STATUS_LABELS, reviewErrorMessage } from '@/lib/plugin-reviews';
import type { OwnReview } from '@/types/plugin-reviews';
import { ReviewForm } from './ReviewForm';
import { ReplyBlock, SanitizedBody, VerifiedUseBadge } from './ReviewItem';
import { Stars } from './StarRating';

/**
 * The signed-in viewer's own review, in any status: edit and delete it. A held
 * review waits for a moderator; a removed one shows the moderator's reason and
 * can no longer be edited (only deleted).
 */
export function OwnReviewPanel({ review, versions, verifiedUse, readOnly = false, onChanged }: {
  review: OwnReview;
  versions: string[];
  verifiedUse: boolean;
  /** A read-only (impersonation) session: Edit and Delete are locked with the reason. */
  readOnly?: boolean;
  /** Re-read the review state and the list. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const removed = review.status === 'removed';

  const del = useMutation({
    fn: () => api.deleteReview(review.id),
    scopeKey: review.id,
    formatError: (err) => reviewErrorMessage(err, 'Could not delete your review'),
    onSuccess: () => { setConfirmDelete(false); onChanged(); },
    onError: () => setConfirmDelete(false),
  });
  const busy = del.pending;
  const error = del.error;
  const remove = () => del.run();

  const lockTitle = readOnly ? READ_ONLY_REASON : undefined;

  if (editing && !readOnly) {
    return (
      <section className="rounded-lg border border-default p-4" aria-label="Edit your review">
        <h3 className="mb-3 text-sm font-semibold text-fg">Edit your review</h3>
        <ReviewForm
          versions={versions}
          initial={review}
          verifiedUse={verifiedUse}
          onSubmit={async (body) => {
            await api.updateReview(review.id, body);
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      </section>
    );
  }

  return (
    <section className="space-y-2 rounded-lg border border-default p-4" aria-label="Your review" data-testid="own-review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">Your review</h3>
          <Badge color={REVIEW_STATUS_COLORS[review.status]}>{REVIEW_STATUS_LABELS[review.status]}</Badge>
          {review.verifiedUse && <VerifiedUseBadge />}
        </div>
        <div className="flex gap-2">
          {!removed && <Button variant="secondary" size="xs" onClick={() => setEditing(true)} disabled={busy || readOnly} title={lockTitle}>Edit your review</Button>}
          <Button variant="danger-outline" size="xs" onClick={() => setConfirmDelete(true)} disabled={busy || readOnly} title={lockTitle}>Delete</Button>
        </div>
      </div>
      {review.status === 'held' && (
        <p className="text-xs text-warning-strong">
          Your review is awaiting moderation and isn’t shown publicly yet.
          {review.moderationReason && <> Reason: {review.moderationReason}</>}
        </p>
      )}
      {removed && (
        <p className="text-xs text-danger-strong" data-testid="own-review-removed">
          A moderator removed your review{review.moderationReason ? `: ${review.moderationReason}` : '.'} It can no longer be edited.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Stars rating={review.rating} />
        {review.title && <span className="text-sm font-medium text-fg">{review.title}</span>}
        {review.version && <span className="font-mono text-xs text-fg-muted">v{review.version}</span>}
        <span className="text-xs text-fg-subtle">{formatDay(review.updatedAt)}</span>
      </div>
      {review.bodyHtml && <SanitizedBody html={review.bodyHtml} />}
      {review.status === 'published' && (
        <p className="text-xs text-fg-muted">{review.helpfulCount} found this helpful</p>
      )}
      {review.reply && <ReplyBlock reply={review.reply} />}
      <ErrorAlert message={error} onDismiss={del.reset} />
      {confirmDelete && !readOnly && (
        <ConfirmDialog
          title="Delete your review?"
          tone="danger"
          confirmLabel="Delete review"
          loading={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        >
          Your rating and review are removed from this plugin. You can write a new one afterwards.
        </ConfirmDialog>
      )}
    </section>
  );
}
