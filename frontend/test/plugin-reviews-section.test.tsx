// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin page's Reviews tab (plan §5, W4):
 *  - guests read reviews and get sign-in links (back to ?tab=reviews), never actions;
 *  - bodies are the server-sanitized HTML, authors are display names only ("Former user" once deleted);
 *  - a signed-in viewer writes, edits (held / removed states) and deletes their review;
 *  - Helpful toggles, Report explains that security reports stay private, publishers reply;
 *  - the reasons a viewer can't review are spelled out;
 *  - sort, star filter and "Load more" drive the public list.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '../src/lib/api/errors';
import type { PublicReview } from '../src/lib/public-directory/types';
import type { OwnReview, ReviewState } from '../src/types/plugin-reviews';
import { detail } from './helpers/publicDirectoryFixtures';

let signedIn = false;
jest.mock('@/components/public-directory/PublicHeader', () => ({
  __esModule: true,
  useClientAuth: () => ({ mounted: true, signedIn, user: signedIn ? { id: 'u1' } : null }),
}));

const getListingReviews = jest.fn<AnyFn>();
jest.mock('@/lib/public-directory/api', () => ({
  __esModule: true,
  getListingReviews: (...a: unknown[]) => getListingReviews(...a),
}));

const api = {
  getReviewState: jest.fn<AnyFn>(),
  createReview: jest.fn<AnyFn>(),
  updateReview: jest.fn<AnyFn>(),
  deleteReview: jest.fn<AnyFn>(),
  voteReviewHelpful: jest.fn<AnyFn>(),
  unvoteReviewHelpful: jest.fn<AnyFn>(),
  reportReview: jest.fn<AnyFn>(),
  putReviewReply: jest.fn<AnyFn>(),
  deleteReviewReply: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }),
}));

import { ReviewsPanel } from '../src/components/public-directory/ListingTabs';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

function review(over: Partial<PublicReview> = {}): PublicReview {
  return {
    id: 'r1', rating: 4, title: 'Solid scanner', bodyHtml: '<p>Finds <strong>real</strong> issues.</p>', version: '1.4.2',
    author: { displayName: 'Dana' }, verifiedUse: true, helpfulCount: 3, edited: false,
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', reply: null, ...over,
  };
}

function ownReview(over: Partial<OwnReview> = {}): OwnReview {
  return {
    id: 'mine', rating: 3, title: 'Okay', bodyMd: 'It **works**', bodyHtml: '<p>It <strong>works</strong></p>', version: null,
    status: 'published', verifiedUse: false, helpfulCount: 0, moderationReason: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', reply: null, ...over,
  };
}

function state(over: Partial<ReviewState> = {}): ReviewState {
  return {
    myReview: null, helpfulReviewIds: [], reportedReviewIds: [], canReview: true, reviewBlockedReason: null,
    canReply: false, verifiedUse: false, ...over,
  };
}

const page = (reviews: PublicReview[], nextCursor: string | null = null, total = reviews.length) =>
  Promise.resolve({ ok: true, data: { reviews, total, nextCursor } });

function renderPanel(over: Parameters<typeof detail>[0] = {}) {
  return render(<ReviewsPanel listing={detail({
    rating: { score: 4.1, count: 12 }, ratingDistribution: { 1: 0, 2: 1, 3: 1, 4: 4, 5: 6 }, recentRating: 4.5, ...over,
  })} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  signedIn = false;
  getListingReviews.mockImplementation(() => page([review()]));
  api.getReviewState.mockImplementation(() => ok(state()));
});

describe('Reviews tab — guest', () => {
  it('shows the summary, the reviews and sign-in links instead of actions', async () => {
    getListingReviews.mockImplementation(() => page([
      review({ edited: true, reply: { bodyHtml: '<p>Thanks, fixed in 1.5.</p>', publisherDisplayName: 'Pipeline Builder', createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z' } }),
      review({ id: 'r2', author: null, verifiedUse: false, title: null, bodyHtml: null }),
    ]));
    renderPanel();
    expect(screen.getByTestId('recent-rating')).toHaveTextContent('Recent versions: 4.5');
    expect(screen.getByRole('list', { name: 'Rating distribution' })).toBeInTheDocument();

    const first = await screen.findByTestId('review-r1');
    expect(first).toHaveTextContent('Dana');
    expect(first).toHaveTextContent('Verified use');
    expect(first).toHaveTextContent('(edited)');
    expect(first).toHaveTextContent('v1.4.2');
    expect(first).toHaveTextContent('3 found this helpful');
    expect(within(first).getByRole('img', { name: '4 out of 5 stars' })).toBeInTheDocument();
    expect(within(first).getByTestId('review-body').innerHTML).toBe('<p>Finds <strong>real</strong> issues.</p>');
    expect(within(first).getByTestId('review-reply')).toHaveTextContent('Pipeline Builder · Publisher response');
    expect(within(first).getByTestId('review-reply')).toHaveTextContent('Thanks, fixed in 1.5.');

    const second = screen.getByTestId('review-r2');
    expect(second).toHaveTextContent('Former user');
    expect(second).not.toHaveTextContent('Verified use');

    const returnTo = '/login?returnTo=%2Fplugins%2Fpipeline-builder%2Ftrivy%3Ftab%3Dreviews';
    expect(screen.getByRole('link', { name: 'Write a review' })).toHaveAttribute('href', returnTo);
    expect(within(first).getByRole('link', { name: 'Sign in to vote or report' })).toHaveAttribute('href', returnTo);
    expect(screen.queryByRole('button', { name: /helpful/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /report/i })).toBeNull();
    expect(api.getReviewState).not.toHaveBeenCalled();
    expect(getListingReviews).toHaveBeenCalledWith('pipeline-builder', 'trivy', { sort: 'helpful', limit: 10 });
  });

  it('says so when there are no ratings or reviews yet', async () => {
    getListingReviews.mockImplementation(() => page([]));
    renderPanel({ rating: null, ratingDistribution: null, recentRating: null });
    expect(screen.getByText('No ratings yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-rating')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Rating distribution' })).toBeNull();
    expect(await screen.findByText('No reviews yet.')).toBeInTheDocument();
  });

  it('sorts, filters by stars and loads more with the cursor', async () => {
    getListingReviews.mockImplementation(() => page([review()], 'c2', 2));
    renderPanel();
    await screen.findByTestId('review-r1');

    getListingReviews.mockImplementationOnce(() => page([review({ id: 'r9' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByTestId('review-r9');
    expect(getListingReviews).toHaveBeenLastCalledWith('pipeline-builder', 'trivy', { sort: 'helpful', cursor: 'c2', limit: 10 });
    expect(screen.getByTestId('review-r1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Sort reviews'), { target: { value: 'recent' } });
    await waitFor(() => expect(getListingReviews).toHaveBeenLastCalledWith('pipeline-builder', 'trivy', { sort: 'recent', limit: 10 }));
    fireEvent.change(screen.getByLabelText('Filter by rating'), { target: { value: '2' } });
    await waitFor(() => expect(getListingReviews).toHaveBeenLastCalledWith('pipeline-builder', 'trivy', { sort: 'recent', rating: 2, limit: 10 }));
  });

  it('offers a retry when the list fails to load', async () => {
    getListingReviews.mockImplementation(() => Promise.resolve({ ok: false, notFound: false, status: 500 }));
    renderPanel();
    expect(await screen.findByText('Reviews could not be loaded.')).toBeInTheDocument();
    getListingReviews.mockImplementation(() => page([review()]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByTestId('review-r1')).toBeInTheDocument();
  });
});

describe('Reviews tab — signed in', () => {
  beforeEach(() => { signedIn = true; });

  it('writes a review with stars, title, body and version', async () => {
    api.createReview.mockImplementation(() => ok({ review: ownReview() }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Write a review' }));
    const form = screen.getByRole('form', { name: 'Write a review' });
    expect(form).toHaveTextContent('Markdown is supported. Links are marked nofollow and images are not shown.');

    // Submitting without stars is refused locally.
    fireEvent.click(within(form).getByRole('button', { name: 'Post review' }));
    expect(await within(form).findByText('Choose a rating from 1 to 5 stars.')).toBeInTheDocument();
    expect(api.createReview).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole('radio', { name: '4 stars' }));
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: ' Great ' } });
    fireEvent.change(within(form).getByLabelText('Review'), { target: { value: 'Use **it**' } });
    fireEvent.change(within(form).getByLabelText('Version you used'), { target: { value: '1.4.2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Post review' }));

    await waitFor(() => expect(api.createReview).toHaveBeenCalledWith('pipeline-builder', 'trivy', {
      rating: 4, title: 'Great', body: 'Use **it**', version: '1.4.2',
    }));
    await waitFor(() => expect(api.getReviewState).toHaveBeenCalledTimes(2));
  });

  it('shows the API error when posting is refused', async () => {
    api.createReview.mockImplementation(() => Promise.reject(new ApiError('dup', 409, 'DUPLICATE_ENTRY')));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Write a review' }));
    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post review' }));
    expect(await screen.findByText("You've already reviewed this plugin. Edit your review instead.")).toBeInTheDocument();
  });

  it('shows a held review as awaiting moderation and edits it from its markdown', async () => {
    api.getReviewState.mockImplementation(() => ok(state({ myReview: ownReview({ status: 'held' }) })));
    api.updateReview.mockImplementation(() => ok({ review: ownReview() }));
    renderPanel();
    const own = await screen.findByTestId('own-review');
    expect(own).toHaveTextContent('Awaiting moderation');
    expect(own).toHaveTextContent('awaiting moderation and isn’t shown publicly');
    expect(screen.queryByRole('button', { name: 'Write a review' })).toBeNull();

    fireEvent.click(within(own).getByRole('button', { name: 'Edit your review' }));
    const form = screen.getByRole('form', { name: 'Edit your review' });
    expect(within(form).getByLabelText('Review')).toHaveValue('It **works**');
    expect(within(form).getByRole('radio', { name: '3 stars' })).toBeChecked();
    fireEvent.click(within(form).getByRole('radio', { name: '5 stars' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(api.updateReview).toHaveBeenCalledWith('mine', { rating: 5, title: 'Okay', body: 'It **works**', version: null }));
  });

  it('clearing the version on an edit sends null, so the server clears it', async () => {
    api.getReviewState.mockImplementation(() => ok(state({ myReview: ownReview({ version: '1.4.2' }) })));
    api.updateReview.mockImplementation(() => ok({ review: ownReview() }));
    renderPanel();
    const own = await screen.findByTestId('own-review');
    fireEvent.click(within(own).getByRole('button', { name: 'Edit your review' }));
    const form = screen.getByRole('form', { name: 'Edit your review' });
    expect(within(form).getByLabelText('Version you used')).toHaveValue('1.4.2');
    fireEvent.change(within(form).getByLabelText('Version you used'), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save review' }));
    await waitFor(() => expect(api.updateReview).toHaveBeenCalledWith('mine', expect.objectContaining({ version: null })));
  });

  it('a removed review shows the moderator reason, cannot be edited, and can be deleted', async () => {
    api.getReviewState.mockImplementation(() => ok(state({ myReview: ownReview({ status: 'removed', moderationReason: 'Abusive language' }) })));
    api.deleteReview.mockImplementation(() => ok({ deleted: true }));
    renderPanel();
    const own = await screen.findByTestId('own-review');
    expect(within(own).getByTestId('own-review-removed')).toHaveTextContent('A moderator removed your review: Abusive language');
    expect(within(own).queryByRole('button', { name: 'Edit your review' })).toBeNull();

    fireEvent.click(within(own).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete review' }));
    await waitFor(() => expect(api.deleteReview).toHaveBeenCalledWith('mine'));
  });

  it('toggles Helpful, but not on the viewer’s own review', async () => {
    getListingReviews.mockImplementation(() => page([review(), review({ id: 'mine', author: { displayName: 'Me' } })]));
    api.getReviewState.mockImplementation(() => ok(state({ myReview: ownReview(), helpfulReviewIds: [] })));
    api.voteReviewHelpful.mockImplementation(() => ok({ helpfulCount: 4, voted: true }));
    api.unvoteReviewHelpful.mockImplementation(() => ok({ helpfulCount: 3, voted: false }));
    renderPanel();

    const mine = await screen.findByTestId('review-mine');
    await waitFor(() => expect(within(mine).getByText('Your review')).toBeInTheDocument());
    expect(within(mine).queryByRole('button', { name: /helpful/i })).toBeNull();
    expect(within(mine).queryByRole('button', { name: /report/i })).toBeNull();

    const other = screen.getByTestId('review-r1');
    const helpful = within(other).getByRole('button', { name: /helpful/i });
    expect(helpful).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(helpful);
    await waitFor(() => expect(within(other).getByTestId('helpful-count')).toHaveTextContent('4 found this helpful'));
    expect(api.voteReviewHelpful).toHaveBeenCalledWith('r1');
    expect(within(other).getByRole('button', { name: /helpful/i })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(other).getByRole('button', { name: /helpful/i }));
    await waitFor(() => expect(within(other).getByTestId('helpful-count')).toHaveTextContent('3 found this helpful'));
    expect(api.unvoteReviewHelpful).toHaveBeenCalledWith('r1');
  });

  it('reports a review; the dialog says security reports stay private', async () => {
    api.reportReview.mockImplementation(() => ok({ reported: true }));
    renderPanel();
    const item = await screen.findByTestId('review-r1');
    fireEvent.click(await within(item).findByRole('button', { name: /report/i }));

    expect(screen.getByTestId('security-report-note')).toHaveTextContent(
      'Security reports are sent privately to the plugin’s publisher and the platform moderators. They never appear publicly.',
    );
    const send = screen.getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Security issue' }));
    fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'Posts a live token' } });
    fireEvent.click(send);

    await waitFor(() => expect(api.reportReview).toHaveBeenCalledWith('r1', 'security', 'Posts a live token'));
    expect(await within(item).findByText('Reported')).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /report/i })).toBeNull();
  });

  it('an already-reported review shows Reported instead of the button', async () => {
    api.getReviewState.mockImplementation(() => ok(state({ reportedReviewIds: ['r1'], helpfulReviewIds: ['r1'] })));
    renderPanel();
    const item = await screen.findByTestId('review-r1');
    expect(await within(item).findByText('Reported')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: /helpful/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a publisher manager responds to, then deletes the response on, a review', async () => {
    api.getReviewState.mockImplementation(() => ok(state({ canReply: true, canReview: false, reviewBlockedReason: 'own_publisher' })));
    api.putReviewReply.mockImplementation(() => ok({ reply: {
      bodyMd: 'Thanks', bodyHtml: '<p>Thanks</p>', publisherDisplayName: 'Pipeline Builder', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    } }));
    api.deleteReviewReply.mockImplementation(() => ok({ deleted: true }));
    renderPanel();

    expect(await screen.findByTestId('review-blocked')).toHaveTextContent("You can't review your own organization's plugins.");
    const item = await screen.findByTestId('review-r1');
    fireEvent.click(await within(item).findByRole('button', { name: 'Respond' }));
    const save = within(item).getByRole('button', { name: 'Save response' });
    expect(save).toBeDisabled();
    fireEvent.change(within(item).getByLabelText('Publisher response'), { target: { value: 'Thanks' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.putReviewReply).toHaveBeenCalledWith('r1', 'Thanks'));
    expect(await within(item).findByTestId('review-reply')).toHaveTextContent('Pipeline Builder · Publisher response');

    fireEvent.click(within(item).getByRole('button', { name: 'Delete response' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete response' }));
    await waitFor(() => expect(api.deleteReviewReply).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(within(item).queryByTestId('review-reply')).toBeNull());
  });

  it.each([
    ['reviews_disabled', 'Reviews are read-only right now.'],
    ['machine_credential', 'Sign in as a person to write a review.'],
  ] as const)('explains why the viewer cannot review (%s)', async (reason, copy) => {
    api.getReviewState.mockImplementation(() => ok(state({ canReview: false, reviewBlockedReason: reason })));
    renderPanel();
    expect(await screen.findByTestId('review-blocked')).toHaveTextContent(copy);
    expect(screen.queryByRole('button', { name: 'Write a review' })).toBeNull();
  });
});

describe('ReviewsPanel — server-rendered first page and fresh re-reads', () => {
  it('shows the server-rendered page without a client fetch for the default view', async () => {
    render(<ReviewsPanel listing={detail({})} initialReviews={{ reviews: [review({ id: 'ssr', title: 'From the server' })], total: 1, nextCursor: null }} />);
    expect(screen.getByText('From the server')).toBeInTheDocument();
    await waitFor(() => expect(api.getReviewState).not.toHaveBeenCalled());
    expect(getListingReviews).not.toHaveBeenCalled();

    // Any other view is still read from the API.
    fireEvent.change(screen.getByLabelText('Sort reviews'), { target: { value: 'recent' } });
    await waitFor(() => expect(getListingReviews).toHaveBeenCalledWith('pipeline-builder', 'trivy', expect.objectContaining({ sort: 'recent' })));
  });

  it('re-reads around the cache after the viewer\'s own review changes', async () => {
    signedIn = true;
    api.createReview.mockImplementation(() => ok({ review: ownReview() }));
    renderPanel();
    await waitFor(() => expect(getListingReviews).toHaveBeenCalledTimes(1));
    expect(getListingReviews.mock.calls[0][2]).not.toHaveProperty('fresh');

    fireEvent.click(await screen.findByRole('button', { name: 'Write a review' }));
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post review' }));
    await waitFor(() => expect(getListingReviews).toHaveBeenCalledTimes(2));
    expect(getListingReviews.mock.calls[1][2]).toMatchObject({ fresh: true });
  });
});
