// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { formatDay } from '@/components/public-directory/ListingCardView';
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
export function OwnReviewPanel({ review, versions, verifiedUse, onChanged }: {
  review: OwnReview;
  versions: string[];
  verifiedUse: boolean;
  /** Re-read the review state and the list. */
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removed = review.status === 'removed';

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteReview(review.id);
      setConfirmDelete(false);
      onChanged();
    } catch (err) {
      setError(reviewErrorMessage(err, 'Could not delete your review'));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
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
          {!removed && <Button variant="secondary" size="xs" onClick={() => setEditing(true)} disabled={busy}>Edit your review</Button>}
          <Button variant="danger-outline" size="xs" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</Button>
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
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {confirmDelete && (
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
