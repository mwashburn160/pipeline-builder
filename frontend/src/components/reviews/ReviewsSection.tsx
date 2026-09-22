// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useClientAuth } from '@/components/public-directory/PublicHeader';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { REVIEW_BLOCKED_COPY, reviewErrorMessage, starsLabel } from '@/lib/plugin-reviews';
import { getListingReviews } from '@/lib/public-directory/api';
import { loginHref, pluginPagePath } from '@/lib/public-directory/links';
import {
  REVIEW_SORTS, REVIEW_SORT_LABELS, type ListingDetail, type PublicReview, type ReviewPage, type ReviewSort,
} from '@/lib/public-directory/types';
import type { ReviewState } from '@/types/plugin-reviews';
import { OwnReviewPanel } from './OwnReviewPanel';
import { ReviewForm } from './ReviewForm';
import { ReviewItem } from './ReviewItem';

/** Also the page size the plugin page server-renders, so the SSR page and the
 *  first client page are the same page. */
export const REVIEWS_PAGE_SIZE = 10;
const PAGE_SIZE = REVIEWS_PAGE_SIZE;
/** The view the server renders: the defaults of the sort and rating controls. */
export const DEFAULT_REVIEW_SORT: ReviewSort = 'helpful';

interface ListState {
  reviews: PublicReview[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: ListState = { reviews: [], total: 0, nextCursor: null, loading: true, error: null };

/**
 * The Reviews tab's list and write surface (plan §5).
 *
 * The first page (default sort, all ratings) is server-rendered from the
 * anonymous public API — so the reviews are in the HTML crawlers and no-JS
 * visitors get, and the page stays viewer-independent and cacheable. Other
 * sorts, filters and later pages load in the browser. Everything
 * viewer-specific — the viewer's own review, their helpful votes and reports,
 * whether they may review or reply — is read from `review-state` only once
 * signed in.
 */
export function ReviewsSection({ listing, initial }: { listing: ListingDetail; initial?: ReviewPage | null }) {
  const publisher = listing.publisher.handle;
  const name = listing.name;
  const signInHref = loginHref(`${pluginPagePath(publisher, name)}?tab=reviews`);
  const { signedIn } = useClientAuth();

  const [sort, setSort] = useState<ReviewSort>(DEFAULT_REVIEW_SORT);
  const [ratingFilter, setRatingFilter] = useState(0);
  const [list, setList] = useState<ListState>(() => (initial
    ? { reviews: initial.reviews, total: initial.total, nextCursor: initial.nextCursor, loading: false, error: null }
    : EMPTY));
  const [reloadTick, setReloadTick] = useState(0);
  const requestSeq = useRef(0);
  // The server-rendered page stands in for the first client read, once.
  const usedInitial = useRef(false);

  const load = useCallback(async (cursor: string | null, opts: { fresh?: boolean } = {}) => {
    const seq = ++requestSeq.current;
    setList((l) => ({ ...(cursor ? l : EMPTY), loading: true, error: null }));
    const res = await getListingReviews(publisher, name, {
      sort, ...(ratingFilter ? { rating: ratingFilter } : {}), ...(cursor ? { cursor } : {}), limit: PAGE_SIZE,
      // After the viewer's own write, the CDN-cached page would still show the
      // list as it was before it — so that re-read goes around every cache.
      ...(opts.fresh ? { fresh: true } : {}),
    });
    if (seq !== requestSeq.current) return;
    if (!res.ok) {
      setList((l) => ({ ...l, loading: false, error: 'Reviews could not be loaded.' }));
      return;
    }
    setList((l) => ({
      reviews: cursor ? [...l.reviews, ...res.data.reviews] : res.data.reviews,
      total: res.data.total,
      nextCursor: res.data.nextCursor,
      loading: false,
      error: null,
    }));
  }, [publisher, name, sort, ratingFilter]);

  useEffect(() => {
    if (!usedInitial.current) {
      usedInitial.current = true;
      if (initial && sort === DEFAULT_REVIEW_SORT && ratingFilter === 0) return;
    }
    void load(null, { fresh: reloadTick > 0 });
    // `initial` is the first render's server page; later changes don't re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, reloadTick]);

  const state = useFetch<ReviewState | null>(async (signal) => {
    if (!signedIn) return null;
    return (await api.getReviewState(publisher, name, { signal })).data ?? null;
  }, [signedIn, publisher, name]);

  // Local overlays on the server's view, updated as the viewer votes and reports.
  const [helpful, setHelpful] = useState<Set<string>>(new Set());
  const [reported, setReported] = useState<Set<string>>(new Set());
  useEffect(() => {
    setHelpful(new Set(state.data?.helpfulReviewIds ?? []));
    setReported(new Set(state.data?.reportedReviewIds ?? []));
  }, [state.data]);

  const afterOwnChange = () => { state.refetch(); setReloadTick((t) => t + 1); };
  const versions = listing.versions.filter((v) => !v.yanked).map((v) => v.version);
  const viewerState = signedIn ? state.data : null;

  const updateReview = (next: PublicReview, flags?: { helpful?: boolean; reported?: boolean }) => {
    setList((l) => ({ ...l, reviews: l.reviews.map((r) => (r.id === next.id ? next : r)) }));
    if (flags?.helpful !== undefined) {
      setHelpful((s) => {
        const n = new Set(s);
        if (flags.helpful) n.add(next.id); else n.delete(next.id);
        return n;
      });
    }
    if (flags?.reported) setReported((s) => new Set(s).add(next.id));
  };

  return (
    <section aria-labelledby="reviews-heading" className="space-y-4">
      <h2 id="reviews-heading" className="sr-only">Reviews</h2>
      <WriteArea
        signedIn={signedIn}
        signInHref={signInHref}
        state={state}
        versions={versions}
        onChanged={afterOwnChange}
        onCreate={async (body) => {
          await api.createReview(publisher, name, body);
          afterOwnChange();
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect aria-label="Sort reviews" value={sort} onChange={(e) => setSort(e.target.value as ReviewSort)}>
          {REVIEW_SORTS.map((s) => <option key={s} value={s}>{REVIEW_SORT_LABELS[s]}</option>)}
        </FilterSelect>
        <FilterSelect aria-label="Filter by rating" value={String(ratingFilter)} onChange={(e) => setRatingFilter(Number(e.target.value))}>
          <option value="0">All ratings</option>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{starsLabel(n)}</option>)}
        </FilterSelect>
        {!list.loading && <span className="text-xs text-fg-subtle">{list.total} review{list.total === 1 ? '' : 's'}</span>}
      </div>

      {list.reviews.length > 0 && (
        <ul className="divide-y divide-default" aria-label="Reviews">
          {list.reviews.map((r) => (
            <li key={r.id}>
              <ReviewItem
                review={r}
                signInHref={signInHref}
                viewer={viewerState ? {
                  isOwn: viewerState.myReview?.id === r.id,
                  helpful: helpful.has(r.id),
                  reported: reported.has(r.id),
                  canReply: viewerState.canReply,
                } : null}
                onChange={updateReview}
              />
            </li>
          ))}
        </ul>
      )}
      {list.loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted"><LoadingSpinner size="sm" /> Loading reviews…</div>
      ) : list.error ? (
        <ErrorAlert message={list.error} onRetry={() => void load(list.reviews.length ? list.nextCursor : null)} />
      ) : list.reviews.length === 0 ? (
        <p className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          {ratingFilter ? `No ${starsLabel(ratingFilter)} reviews.` : 'No reviews yet.'}
        </p>
      ) : list.nextCursor && (
        <Button variant="secondary" size="sm" onClick={() => void load(list.nextCursor)}>Load more</Button>
      )}
    </section>
  );
}

/** "Write a review" / the viewer's own review / why they can't review. */
function WriteArea({ signedIn, signInHref, state, versions, onChanged, onCreate }: {
  signedIn: boolean;
  signInHref: string;
  state: { data: ReviewState | null; loading: boolean; error: Error | null; refetch: () => void };
  versions: string[];
  onChanged: () => void;
  onCreate: Parameters<typeof ReviewForm>[0]['onSubmit'];
}) {
  const [writing, setWriting] = useState(false);

  if (!signedIn) {
    return (
      <div>
        <Link href={signInHref} className="btn btn-primary px-4 py-2 text-sm">Write a review</Link>
        <p className="mt-1 text-xs text-fg-subtle">Sign in to write a review.</p>
      </div>
    );
  }
  if (state.loading && !state.data) {
    return <p className="text-sm text-fg-subtle" aria-busy="true">Checking your review…</p>;
  }
  if (!state.data) {
    return <ErrorAlert message={reviewErrorMessage(state.error, 'Could not load your review')} onRetry={state.refetch} />;
  }
  const s = state.data;
  if (s.myReview) {
    return <OwnReviewPanel review={s.myReview} versions={versions} verifiedUse={s.verifiedUse} onChanged={onChanged} />;
  }
  if (!s.canReview) {
    return (
      <p className="text-sm text-fg-muted" data-testid="review-blocked">
        {s.reviewBlockedReason ? REVIEW_BLOCKED_COPY[s.reviewBlockedReason] : 'You can’t review this plugin.'}
      </p>
    );
  }
  if (!writing) {
    return <Button size="sm" onClick={() => setWriting(true)}>Write a review</Button>;
  }
  return (
    <section className="rounded-lg border border-default p-4" aria-label="Write a review">
      <h3 className="mb-3 text-sm font-semibold text-fg">Write a review</h3>
      <ReviewForm
        versions={versions}
        initial={null}
        verifiedUse={s.verifiedUse}
        onSubmit={async (body) => {
          await onCreate(body);
          setWriting(false);
        }}
        onCancel={() => setWriting(false)}
      />
    </section>
  );
}
