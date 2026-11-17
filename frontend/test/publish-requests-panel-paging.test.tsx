// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PublishRequestsPanel "Load more": a continuation page still in flight when
 * the status filter changes belongs to the PREVIOUS list, and must be dropped
 * rather than appended under the new filter.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const listPublishRequests = jest.fn<AnyFn>();
const listIncomingTransfers = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPublishRequests: (...a: unknown[]) => listPublishRequests(...a),
    listIncomingTransfers: (...a: unknown[]) => listIncomingTransfers(...a),
  },
}));

import { PublishRequestsPanel } from '../src/components/publisher/PublishRequestsPanel';

function req(id: string, status = 'pending') {
  return {
    id, kind: 'new_version', status, lane: 'standard', publisherId: 'p1', publisherHandle: 'acme',
    publisherTier: 'community', listingId: 'l1', listingName: `plugin-${id}`, pluginId: null, version: '1.0.0',
    digest: null, payload: {}, submittedBy: 'u1', submittedOrgId: 'org-1', submittedAt: '2026-09-01T00:00:00Z',
    firstApprovedBy: null, secondApprovedBy: null, decidedBy: null, decidedAt: null, reason: null,
  };
}
const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

beforeEach(() => {
  jest.clearAllMocks();
  listIncomingTransfers.mockReturnValue(ok({ requests: [] }));
});

describe('PublishRequestsPanel paging', () => {
  it('drops a "Load more" page that lands after the filter changed', async () => {
    let releaseMore: (v: unknown) => void = () => undefined;
    listPublishRequests.mockImplementation((params: { status?: string; cursor?: string }) => {
      if (params.cursor) return new Promise((res) => { releaseMore = res; });
      if (params.status === 'approved') return ok({ requests: [req('approved-1', 'approved')], nextCursor: null });
      return ok({ requests: [req('first')], nextCursor: 'c1' });
    });
    render(<PublishRequestsPanel canPublish canManage={false} />);
    await screen.findByTestId('request-first');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(listPublishRequests).toHaveBeenCalledWith({ cursor: 'c1' }));

    const group = screen.getByRole('group', { name: 'Filter requests by status' });
    fireEvent.click(within(group).getByRole('button', { name: 'Approved' }));
    await screen.findByTestId('request-approved-1');

    // The unfiltered list's continuation now resolves.
    releaseMore({ success: true, statusCode: 200, data: { requests: [req('stale')], nextCursor: null } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('request-stale')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Publish requests' })).getAllByRole('listitem')).toHaveLength(1);
  });
});
