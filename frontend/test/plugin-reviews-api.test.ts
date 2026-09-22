// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin reviews API (plan §5, W4): every authenticated method hits the
 * contract's path with the right verb and body, and the anonymous review list
 * goes through the credential-free public client with its query string.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ApiCore } from '../src/lib/api/core';
import { pluginReviewsApi } from '../src/lib/api/domains/plugin-reviews';
import { getListingReviews } from '../src/lib/public-directory/api';
import { ApiError } from '../src/lib/api/errors';
import { reviewErrorMessage, starsLabel } from '../src/lib/plugin-reviews';
import { jsonResponse } from './helpers/publicDirectoryFixtures';

function fakeCore() {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const core = {
    request: jest.fn<AnyFn>((path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return Promise.resolve({ success: true, statusCode: 200, data: {} });
    }),
    stepUpHeader: (t?: string) => (t ? { 'X-Step-Up-Token': t } : {}),
  } as unknown as ApiCore;
  return { api: pluginReviewsApi(core), calls };
}

const body = (init: RequestInit) => (init.body ? JSON.parse(String(init.body)) : undefined);

describe('plugin reviews API — viewer', () => {
  it('reads the review state and writes a review', async () => {
    const { api, calls } = fakeCore();
    await api.getReviewState('acme', 'tf plan');
    await api.createReview('acme', 'tf', { rating: 4, title: 'Good', body: 'Works', version: '1.0.0' });
    await api.updateReview('r 1', { rating: 5 });
    await api.deleteReview('r1');

    expect(calls[0].path).toBe('/api/plugins/listings/acme/tf%20plan/review-state');
    expect(calls[0].init.method).toBeUndefined();
    expect(calls[1]).toMatchObject({ path: '/api/plugins/listings/acme/tf/reviews', init: { method: 'POST' } });
    expect(body(calls[1].init)).toEqual({ rating: 4, title: 'Good', body: 'Works', version: '1.0.0' });
    expect(calls[2]).toMatchObject({ path: '/api/plugins/reviews/r%201', init: { method: 'PATCH' } });
    expect(body(calls[2].init)).toEqual({ rating: 5 });
    expect(calls[3]).toMatchObject({ path: '/api/plugins/reviews/r1', init: { method: 'DELETE' } });
  });

  it('votes, reports and replies', async () => {
    const { api, calls } = fakeCore();
    await api.voteReviewHelpful('r1');
    await api.unvoteReviewHelpful('r1');
    await api.reportReview('r1', 'spam');
    await api.reportReview('r1', 'security', 'Leaks a token');
    await api.putReviewReply('r1', 'Thanks!');
    await api.deleteReviewReply('r1');

    expect(calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      'PUT /api/plugins/reviews/r1/helpful',
      'DELETE /api/plugins/reviews/r1/helpful',
      'POST /api/plugins/reviews/r1/report',
      'POST /api/plugins/reviews/r1/report',
      'PUT /api/plugins/reviews/r1/reply',
      'DELETE /api/plugins/reviews/r1/reply',
    ]);
    expect(body(calls[2].init)).toEqual({ category: 'spam' });
    expect(body(calls[3].init)).toEqual({ category: 'security', reason: 'Leaks a token' });
    expect(body(calls[4].init)).toEqual({ body: 'Thanks!' });
  });
});

describe('plugin reviews API — moderation', () => {
  it('lists the queue and decides', async () => {
    const { api, calls } = fakeCore();
    await api.listModerationReviews();
    await api.listModerationReviews({ queue: 'removed' });
    await api.holdReview('r1', 'Suspicious burst');
    await api.releaseReview('r1');
    await api.releaseReview('r1', 'Fine after all');
    await api.removeReview('r1', 'Abusive');
    await api.removeReviewReply('r1', 'Off topic');

    expect(calls[0].path).toBe('/api/plugins/ecosystem/reviews');
    expect(calls[1].path).toBe('/api/plugins/ecosystem/reviews?queue=removed');
    expect(calls.slice(2).map((c) => `${c.init.method} ${c.path}`)).toEqual([
      'POST /api/plugins/ecosystem/reviews/r1/hold',
      'POST /api/plugins/ecosystem/reviews/r1/release',
      'POST /api/plugins/ecosystem/reviews/r1/release',
      'POST /api/plugins/ecosystem/reviews/r1/remove',
      'POST /api/plugins/ecosystem/reviews/r1/remove-reply',
    ]);
    expect(body(calls[2].init)).toEqual({ reason: 'Suspicious burst' });
    expect(body(calls[3].init)).toEqual({});
    expect(body(calls[4].init)).toEqual({ note: 'Fine after all' });
    expect(body(calls[5].init)).toEqual({ reason: 'Abusive' });
    expect(body(calls[6].init)).toEqual({ reason: 'Off topic' });
  });
});

describe('public review list', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('builds the query and sends no credentials', async () => {
    const fetchMock = jest.fn<AnyFn>().mockResolvedValue(jsonResponse(200, { reviews: [], total: 0, nextCursor: null }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await getListingReviews('acme', 'tf', { sort: 'lowest', rating: 2, cursor: 'c 1', limit: 10 });
    expect(res).toEqual({ ok: true, data: { reviews: [], total: 0, nextCursor: null } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/public\/plugins\/acme\/tf\/reviews\?sort=lowest&rating=2&cursor=c\+1&limit=10$/);
    expect(init.credentials).toBe('omit');
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('authorization');

    await getListingReviews('acme', 'tf');
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/reviews$/);
  });
});

describe('review error copy', () => {
  it('maps the review codes and keeps other messages', () => {
    expect(reviewErrorMessage(new ApiError('dup', 409, 'DUPLICATE_ENTRY'))).toMatch(/already reviewed/);
    expect(reviewErrorMessage(new ApiError('dup', 409, 'DUPLICATE_ENTRY'), 'x', { DUPLICATE_ENTRY: 'Already reported.' })).toBe('Already reported.');
    expect(reviewErrorMessage(new ApiError('no', 403, 'REVIEW_SELF_PROMOTION'))).toMatch(/own organization/);
    expect(reviewErrorMessage(new ApiError('no', 403, 'PLUGIN_REVIEWS_DISABLED'))).toMatch(/read-only/);
    expect(reviewErrorMessage(new ApiError('no', 403, 'HUMAN_SESSION_REQUIRED'))).toMatch(/as a person/);
    expect(reviewErrorMessage(new ApiError('slow', 429, 'RATE_LIMIT_EXCEEDED'))).toMatch(/Too many/);
    expect(reviewErrorMessage(new ApiError('gone', 409, 'CONFLICT'))).toMatch(/removed by a moderator/);
    expect(reviewErrorMessage(new ApiError('Title too long', 400, 'VALIDATION_ERROR'))).toBe('Title too long');
    expect(reviewErrorMessage(null, 'Fallback')).toBe('Fallback');
    expect(starsLabel(1)).toBe('1 star');
    expect(starsLabel(4)).toBe('4 stars');
  });
});
