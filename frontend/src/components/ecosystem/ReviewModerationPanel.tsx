// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { MessageSquareWarning } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { SegmentedFilter } from '@/components/ui/SegmentedFilter';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { ReplyBlock, SanitizedBody, VerifiedUseBadge } from '@/components/reviews/ReviewItem';
import { Stars } from '@/components/reviews/StarRating';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import {
  HOLD_REASON_LABELS, REPORT_CATEGORY_LABELS, REVIEW_STATUS_COLORS, REVIEW_STATUS_LABELS,
} from '@/lib/plugin-reviews';
import { pluginPagePath } from '@/lib/public-directory/links';
import type { ModerationReview, ReviewModerationQueue } from '@/types/plugin-reviews';
import { EcosystemActionDialog } from './EcosystemActionDialog';

interface Props {
  /** `useAuthGuard().can` — false for every ecosystem action during a read-only impersonation. */
  can: (permission: string) => boolean;
}

type ActionKind = 'hold' | 'release' | 'remove' | 'remove-reply';
type Action = { kind: ActionKind; review: ModerationReview };

const QUEUE_OPTIONS = [
  { value: 'open', label: 'Open queue' },
  { value: 'removed', label: 'Removed' },
] as const;

const ACTION_COPY: Record<ActionKind, {
  label: string; title: string; details: string; reasonLabel: string; required: boolean; tone: 'primary' | 'danger'; done: string;
}> = {
  hold: {
    label: 'Hold', title: 'Hold this review?', reasonLabel: 'Reason', required: true, tone: 'primary', done: 'Review held',
    details: 'The review leaves the public page until it is released. Its author sees it as awaiting moderation.',
  },
  release: {
    label: 'Release', title: 'Release this review?', reasonLabel: 'Note', required: false, tone: 'primary', done: 'Review released',
    details: 'The review is published again and its open reports are resolved.',
  },
  remove: {
    label: 'Remove', title: 'Remove this review?', reasonLabel: 'Reason', required: true, tone: 'danger', done: 'Review removed',
    details: 'The review and its rating are taken down. The author sees the reason and can no longer edit it.',
  },
  'remove-reply': {
    label: 'Remove reply', title: 'Remove the publisher reply?', reasonLabel: 'Reason', required: true, tone: 'danger', done: 'Reply removed',
    details: 'The publisher response is taken down; the review itself stays.',
  },
};

/**
 * Ecosystem console → Review moderation (plan §5, `plugins:moderate`): held and
 * reported reviews, and the removed ones. Moderators may hold, release or
 * remove a review, and remove a publisher reply. Reviewer org is never shown;
 * the user id is, for moderators only.
 */
export function ReviewModerationPanel({ can }: Props) {
  const toast = useToast();
  const mayModerate = can('plugins:moderate');
  const [queue, setQueue] = useState<ReviewModerationQueue>('open');
  const [action, setAction] = useState<Action | null>(null);

  const reviewsQ = useFetch(async (signal) => {
    const res = await api.listModerationReviews({ queue }, { signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load reviews');
    return res.data.reviews;
  }, [queue]);
  const reviews = reviewsQ.data ?? [];

  const run = async (text: string) => {
    if (!action) return;
    const { kind, review } = action;
    if (kind === 'hold') await api.holdReview(review.id, text);
    else if (kind === 'release') await api.releaseReview(review.id, text || undefined);
    else if (kind === 'remove') await api.removeReview(review.id, text);
    else await api.removeReviewReply(review.id, text);
    toast.success(ACTION_COPY[kind].done);
    reviewsQ.refetch();
  };

  const actionsFor = (r: ModerationReview): ActionKind[] => {
    const out: ActionKind[] = [];
    if (r.status === 'published') out.push('hold');
    if (r.status !== 'published' || r.openReportCount > 0) out.push('release');
    if (r.status !== 'removed') out.push('remove');
    if (r.reply) out.push('remove-reply');
    return out;
  };

  return (
    <SectionCard
      icon={MessageSquareWarning}
      title="Review moderation"
      description="Held and reported reviews, and the ones taken down."
    >
      <div className="space-y-4">
        <SegmentedFilter
          ariaLabel="Review queue"
          options={QUEUE_OPTIONS}
          value={queue}
          onChange={(v) => setQueue(v)}
        />

        {reviewsQ.loading && !reviewsQ.data ? (
          <Skeleton className="h-24 w-full" />
        ) : reviewsQ.error ? (
          <RetryError message={formatError(reviewsQ.error, 'Failed to load reviews')} onRetry={reviewsQ.refetch} />
        ) : reviews.length === 0 ? (
          <EmptyState compact icon={MessageSquareWarning} title={queue === 'open' ? 'No reviews need moderation' : 'No removed reviews'} />
        ) : (
          <ul className="space-y-3" aria-label="Reviews to moderate">
            {reviews.map((r) => (
              <li key={r.id} className="space-y-2 rounded-lg border border-default p-3" data-testid={`mod-review-${r.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Link href={pluginPagePath(r.listing.publisher, r.listing.name)} className="font-mono font-medium text-fg hover:underline">
                      {r.listing.publisher}/{r.listing.name}
                    </Link>
                    <Stars rating={r.rating} />
                    <Badge color={REVIEW_STATUS_COLORS[r.status]}>{REVIEW_STATUS_LABELS[r.status]}</Badge>
                    {r.holdReason && <Badge color="purple">{HOLD_REASON_LABELS[r.holdReason]}</Badge>}
                    {r.openReportCount > 0 && <Badge color="red">{r.openReportCount} open report{r.openReportCount === 1 ? '' : 's'}</Badge>}
                  </div>
                  {mayModerate && (
                    <div className="flex flex-wrap gap-1">
                      {actionsFor(r).map((k) => (
                        <Button
                          key={k}
                          size="xs"
                          variant={ACTION_COPY[k].tone === 'danger' ? 'danger-outline' : 'secondary'}
                          onClick={() => setAction({ kind: k, review: r })}
                          aria-label={`${ACTION_COPY[k].label}: review ${r.id}`}
                        >
                          {ACTION_COPY[k].label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                  <span className="font-medium text-fg">{r.author.displayName ?? 'Former user'}</span>
                  {r.author.userId && <span className="font-mono text-fg-subtle">{r.author.userId}</span>}
                  {r.verifiedUse && <VerifiedUseBadge />}
                  {r.version && <span className="font-mono">v{r.version}</span>}
                  <RelativeTime value={r.createdAt} />
                  <span>· {r.helpfulCount} helpful</span>
                </p>
                {r.title && <p className="text-sm font-semibold text-fg">{r.title}</p>}
                {r.bodyHtml && <SanitizedBody html={r.bodyHtml} />}
                {r.moderationReason && <p className="text-xs text-fg-muted">Moderation reason: {r.moderationReason}</p>}
                {r.reports.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-fg">Reports</p>
                    <ul className="space-y-1 text-xs" aria-label={`Reports on review ${r.id}`}>
                      {r.reports.map((rep, i) => (
                        <li key={`${rep.createdAt}-${i}`} className="flex flex-wrap items-center gap-2">
                          <Badge color={rep.category === 'security' ? 'red' : 'gray'}>{REPORT_CATEGORY_LABELS[rep.category]}</Badge>
                          {rep.reason && <span className="text-fg">{rep.reason}</span>}
                          <RelativeTime value={rep.createdAt} className="text-fg-subtle" />
                          {rep.resolved && <span className="text-fg-subtle">(resolved)</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.reply && <ReplyBlock reply={r.reply} />}
              </li>
            ))}
          </ul>
        )}
      </div>

      {action && (
        <EcosystemActionDialog
          title={ACTION_COPY[action.kind].title}
          action={`${ACTION_COPY[action.kind].label}: review of ${action.review.listing.publisher}/${action.review.listing.name}`}
          details={<p>{ACTION_COPY[action.kind].details}</p>}
          reasonLabel={ACTION_COPY[action.kind].reasonLabel}
          reasonRequired={ACTION_COPY[action.kind].required}
          confirmLabel={ACTION_COPY[action.kind].label}
          tone={ACTION_COPY[action.kind].tone}
          stepUp={false}
          onSubmit={run}
          onClose={() => setAction(null)}
        />
      )}
    </SectionCard>
  );
}
