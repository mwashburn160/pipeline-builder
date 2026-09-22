// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, Flag, MessageSquareReply, ThumbsUp } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Textarea } from '@/components/ui/Textarea';
import { formatDay } from '@/components/public-directory/ListingCardView';
import api from '@/lib/api';
import { REPLY_BODY_MAX, reviewErrorMessage } from '@/lib/plugin-reviews';
import type { PublicReview, ReviewReply } from '@/lib/public-directory/types';
import { MarkdownNote } from './ReviewForm';
import { ReportReviewDialog } from './ReportReviewDialog';
import { Stars } from './StarRating';

/** Server-rendered, server-SANITIZED review / reply HTML (the README's pattern). Injected as-is. */
export function SanitizedBody({ html, testId }: { html: string; testId?: string }) {
  return <div className="pb-readme text-sm" data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** "Verified use": the reviewer's org ran the plugin recently. The org itself is never shown. */
export function VerifiedUseBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-strong">
      <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />Verified use
    </span>
  );
}

/** A publisher's public response under a review. */
export function ReplyBlock({ reply }: { reply: ReviewReply }) {
  return (
    <div className="ml-4 space-y-1 border-l-2 border-default pl-3" data-testid="review-reply">
      <p className="text-xs text-fg-muted">
        <span className="font-medium text-fg">{reply.publisherDisplayName}</span> · Publisher response · {formatDay(reply.createdAt)}
      </p>
      <SanitizedBody html={reply.bodyHtml} />
    </div>
  );
}

/** What the viewer may do with a review; null for a guest. */
export interface ReviewViewer {
  isOwn: boolean;
  helpful: boolean;
  reported: boolean;
  canReply: boolean;
}

/**
 * One published review. Guests see sign-in links in place of the Helpful and
 * Report actions; the viewer's own review has neither.
 */
export function ReviewItem({
  review, viewer, signInHref, onChange,
}: {
  review: PublicReview;
  viewer: ReviewViewer | null;
  signInHref: string;
  /** A local update: helpful count, reported, reply. */
  onChange: (next: PublicReview, flags?: { helpful?: boolean; reported?: boolean }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [replying, setReplying] = useState(false);
  const [confirmDeleteReply, setConfirmDeleteReply] = useState(false);
  const author = review.author?.displayName ?? 'Former user';

  const toggleHelpful = async () => {
    if (!viewer) return;
    setBusy(true);
    setError(null);
    try {
      const res = viewer.helpful ? await api.unvoteReviewHelpful(review.id) : await api.voteReviewHelpful(review.id);
      const data = res.data;
      onChange({ ...review, helpfulCount: data?.helpfulCount ?? review.helpfulCount }, { helpful: data?.voted ?? !viewer.helpful });
    } catch (err) {
      setError(reviewErrorMessage(err, 'Could not record your vote'));
    } finally {
      setBusy(false);
    }
  };

  const deleteReply = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteReviewReply(review.id);
      onChange({ ...review, reply: null });
    } catch (err) {
      setError(reviewErrorMessage(err, 'Could not delete the response'));
    } finally {
      setBusy(false);
      setConfirmDeleteReply(false);
    }
  };

  return (
    <article className="space-y-2 py-4" data-testid={`review-${review.id}`} aria-label={`Review by ${author}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Stars rating={review.rating} />
        {review.title && <h3 className="text-sm font-semibold text-fg">{review.title}</h3>}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
        <span className="font-medium text-fg">{author}</span>
        {viewer?.isOwn && <Badge color="blue">Your review</Badge>}
        {review.verifiedUse && <VerifiedUseBadge />}
        {review.version && <span className="font-mono">v{review.version}</span>}
        <span>{formatDay(review.createdAt)}</span>
        {review.edited && <span>(edited)</span>}
      </p>
      {review.bodyHtml && <SanitizedBody html={review.bodyHtml} testId="review-body" />}

      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <span data-testid="helpful-count">{review.helpfulCount} found this helpful</span>
        {!viewer ? (
          <Link href={signInHref} className="action-link">Sign in to vote or report</Link>
        ) : !viewer.isOwn && (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void toggleHelpful()}
              disabled={busy}
              aria-pressed={viewer.helpful}
            >
              <ThumbsUp className={`h-3.5 w-3.5 ${viewer.helpful ? 'fill-current' : ''}`} aria-hidden="true" /> Helpful
            </Button>
            {viewer.reported ? (
              <span>Reported</span>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => setReporting(true)} disabled={busy}>
                <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Report
              </Button>
            )}
          </>
        )}
        {viewer?.canReply && !replying && (
          <>
            <Button variant="ghost" size="xs" onClick={() => setReplying(true)} disabled={busy}>
              <MessageSquareReply className="h-3.5 w-3.5" aria-hidden="true" /> {review.reply ? 'Edit response' : 'Respond'}
            </Button>
            {review.reply && (
              <Button variant="ghost" size="xs" onClick={() => setConfirmDeleteReply(true)} disabled={busy}>Delete response</Button>
            )}
          </>
        )}
      </div>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      {replying ? (
        <ReplyEditor
          reviewId={review.id}
          hasReply={!!review.reply}
          onSaved={(reply) => { onChange({ ...review, reply }); setReplying(false); }}
          onCancel={() => setReplying(false)}
        />
      ) : review.reply && <ReplyBlock reply={review.reply} />}

      {reporting && (
        <ReportReviewDialog
          reviewId={review.id}
          onReported={() => onChange(review, { reported: true })}
          onClose={() => setReporting(false)}
        />
      )}
      {confirmDeleteReply && (
        <ConfirmDialog
          title="Delete your response?"
          tone="danger"
          confirmLabel="Delete response"
          loading={busy}
          onConfirm={() => void deleteReply()}
          onCancel={() => setConfirmDeleteReply(false)}
        >
          The publisher response is removed from this review for everyone.
        </ConfirmDialog>
      )}
    </article>
  );
}

/**
 * The publisher's reply form. The reply list carries only the rendered HTML,
 * so an edit starts empty and REPLACES the current response.
 */
function ReplyEditor({ reviewId, hasReply, onSaved, onCancel }: {
  reviewId: string;
  hasReply: boolean;
  onSaved: (reply: ReviewReply) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const save = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.putReviewReply(reviewId, body.trim());
      if (res.data?.reply) {
        const { bodyHtml, publisherDisplayName, createdAt, updatedAt } = res.data.reply;
        onSaved({ bodyHtml, publisherDisplayName, createdAt, updatedAt });
      }
    } catch (err) {
      setError(reviewErrorMessage(err, 'Could not save the response'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ml-4 space-y-2 border-l-2 border-default pl-3">
      <FormField
        label={hasReply ? 'New publisher response' : 'Publisher response'}
        id={id}
        hint={hasReply ? 'Replaces the current response.' : `Shown publicly under the review, up to ${REPLY_BODY_MAX} characters.`}
      >
        <Textarea id={id} rows={3} value={body} maxLength={REPLY_BODY_MAX} onChange={(e) => setBody(e.target.value)} disabled={busy} />
      </FormField>
      <p className="text-xs text-fg-subtle"><MarkdownNote /></p>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="flex gap-2">
        <Button size="xs" onClick={() => void save()} loading={busy} disabled={!body.trim()}>Save response</Button>
        <Button variant="secondary" size="xs" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
