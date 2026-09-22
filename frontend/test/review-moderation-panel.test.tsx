// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ecosystem console → Review moderation:
 *  - the open queue renders each review's listing, stars, sanitized body, author
 *    display name + user id, verified-use badge, status, hold reason, reports and reply;
 *  - hold / remove / remove-reply need a reason, release takes an optional note;
 *  - a viewer without `plugins:moderate` (incl. a read-only impersonation) gets no actions;
 *  - the Removed filter reads the other queue.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ModerationReview } from '../src/types/plugin-reviews';
import { pageToast } from './helpers/pageMocks';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const api = {
  listModerationReviews: jest.fn<AnyFn>(),
  holdReview: jest.fn<AnyFn>(),
  releaseReview: jest.fn<AnyFn>(),
  removeReview: jest.fn<AnyFn>(),
  removeReviewReply: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }),
}));

import { ReviewModerationPanel } from '../src/components/ecosystem/ReviewModerationPanel';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

function modReview(over: Partial<ModerationReview> = {}): ModerationReview {
  return {
    id: 'rv1', listing: { id: 'l1', publisher: 'acme', name: 'eslint' }, rating: 1, title: 'Scam',
    bodyHtml: '<p>Buy <a href="https://x.test" rel="nofollow ugc noopener">this</a></p>', version: '1.0.0',
    author: { userId: 'u-42', displayName: 'Spammy' }, verifiedUse: true, status: 'held', holdReason: 'reports',
    moderationReason: null, helpfulCount: 0, openReportCount: 2,
    reports: [
      { category: 'spam', reason: 'Advertising', createdAt: '2026-09-20T00:00:00Z', resolved: false },
      { category: 'security', reason: null, createdAt: '2026-09-20T01:00:00Z', resolved: false },
    ],
    reply: { bodyHtml: '<p>Not ours</p>', publisherDisplayName: 'Acme Corp', createdAt: '2026-09-20T02:00:00Z', updatedAt: '2026-09-20T02:00:00Z' },
    createdAt: '2026-09-19T00:00:00Z', updatedAt: '2026-09-19T00:00:00Z', ...over,
  };
}

const canAll = () => true;
const canNone = () => false;

beforeEach(() => {
  jest.clearAllMocks();
  api.listModerationReviews.mockImplementation(() => ok({ reviews: [modReview()] }));
  for (const fn of [api.holdReview, api.releaseReview, api.removeReview, api.removeReviewReply]) {
    fn.mockImplementation(() => ok({ review: modReview() }));
  }
});

describe('ReviewModerationPanel', () => {
  it('renders a queue item with everything a moderator needs', async () => {
    render(<ReviewModerationPanel can={canAll} />);
    const item = await screen.findByTestId('mod-review-rv1');
    expect(api.listModerationReviews).toHaveBeenCalledWith({ queue: 'open' }, expect.anything());
    expect(within(item).getByRole('link', { name: 'acme/eslint' })).toHaveAttribute('href', '/plugins/acme/eslint');
    expect(within(item).getByRole('img', { name: '1 out of 5 stars' })).toBeInTheDocument();
    expect(item).toHaveTextContent('Awaiting moderation');
    expect(item).toHaveTextContent('Reported by users');
    expect(item).toHaveTextContent('2 open reports');
    expect(item).toHaveTextContent('Spammy');
    expect(item).toHaveTextContent('u-42');
    expect(item).toHaveTextContent('Verified use');
    expect(item).toHaveTextContent('Scam');
    expect(item.querySelector('a[rel="nofollow ugc noopener"]')).not.toBeNull();
    const reports = within(item).getByRole('list', { name: 'Reports on review rv1' });
    expect(reports).toHaveTextContent('Spam or advertising');
    expect(reports).toHaveTextContent('Advertising');
    expect(reports).toHaveTextContent('Security issue');
    expect(within(item).getByTestId('review-reply')).toHaveTextContent('Acme Corp · Publisher response');
    // Held: release / remove / remove-reply; no hold.
    expect(within(item).queryByRole('button', { name: /^hold/i })).toBeNull();
    expect(within(item).getByRole('button', { name: 'Release: review rv1' })).toBeInTheDocument();
  });

  it('holds a published review with a required reason', async () => {
    api.listModerationReviews.mockImplementation(() => ok({ reviews: [modReview({ status: 'published', holdReason: null, reply: null })] }));
    render(<ReviewModerationPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hold: review rv1' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Hold' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Spam wave' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.holdReview).toHaveBeenCalledWith('rv1', 'Spam wave'));
    expect(pageToast.success).toHaveBeenCalledWith('Review held');
    await waitFor(() => expect(api.listModerationReviews).toHaveBeenCalledTimes(2));
  });

  it('releases with an optional note, and removes the review and the reply with reasons', async () => {
    render(<ReviewModerationPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release: review rv1' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(api.releaseReview).toHaveBeenCalledWith('rv1', undefined));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(await screen.findByRole('button', { name: 'Remove: review rv1' }));
    dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Abusive' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeReview).toHaveBeenCalledWith('rv1', 'Abusive'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(await screen.findByRole('button', { name: 'Remove reply: review rv1' }));
    dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Harassing the reviewer' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove reply' }));
    await waitFor(() => expect(api.removeReviewReply).toHaveBeenCalledWith('rv1', 'Harassing the reviewer'));
  });

  it('keeps the dialog open with the error when an action fails', async () => {
    api.releaseReview.mockImplementation(() => Promise.reject(new Error('Review changed meanwhile')));
    render(<ReviewModerationPanel can={canAll} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release: review rv1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Release' }));
    expect(await within(screen.getByRole('dialog')).findByText('Review changed meanwhile')).toBeInTheDocument();
  });

  it('shows no actions without plugins:moderate (e.g. read-only impersonation)', async () => {
    render(<ReviewModerationPanel can={canNone} />);
    const item = await screen.findByTestId('mod-review-rv1');
    expect(within(item).queryAllByRole('button')).toHaveLength(0);
  });

  it('switches to the removed queue', async () => {
    render(<ReviewModerationPanel can={canAll} />);
    await screen.findByTestId('mod-review-rv1');
    api.listModerationReviews.mockImplementation(() => ok({ reviews: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Removed' }));
    await waitFor(() => expect(api.listModerationReviews).toHaveBeenLastCalledWith({ queue: 'removed' }, expect.anything()));
    expect(await screen.findByText('No removed reviews')).toBeInTheDocument();
  });

  it('shows a retry when the queue fails to load', async () => {
    api.listModerationReviews.mockImplementation(() => Promise.resolve({ success: false, statusCode: 500, message: 'boom' }));
    render(<ReviewModerationPanel can={canAll} />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
