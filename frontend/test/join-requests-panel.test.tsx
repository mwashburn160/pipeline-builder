// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org admin's domain-join requests: Pending (approve / deny) and Denied
 * (clear the sticky denial, DELETE /organization/:id/join-requests/:reqId),
 * each paged by offset + `hasMore`.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JoinRequestsPanel, JOIN_REQUEST_PAGE_SIZE } from '../src/components/settings/JoinRequestsPanel';

const success = jest.fn<AnyFn>();
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success, error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));

const listOrgJoinRequests = jest.fn<AnyFn>();
const decideOrgJoinRequest = jest.fn<AnyFn>();
const clearOrgJoinRequest = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOrgJoinRequests: (...a: unknown[]) => listOrgJoinRequests(...a),
    decideOrgJoinRequest: (...a: unknown[]) => decideOrgJoinRequest(...a),
    clearOrgJoinRequest: (...a: unknown[]) => clearOrgJoinRequest(...a),
  },
}));

const row = (id: string, status: 'pending' | 'denied', extra: Record<string, unknown> = {}) => ({
  id, userId: `u-${id}`, email: `${id}@acme.com`, status, requestedAt: '2026-01-01T00:00:00Z', ...extra,
});
type ListOpts = { status?: string; offset?: number };
const lastOpts = (): ListOpts => (listOrgJoinRequests.mock.calls.at(-1)?.[1] ?? {}) as ListOpts;

beforeEach(() => {
  jest.clearAllMocks();
  listOrgJoinRequests.mockImplementation(async (_org: unknown, opts: unknown) => {
    const o = (opts ?? {}) as ListOpts;
    if (o.status === 'denied') return { success: true, data: { requests: [row('d1', 'denied', { decidedAt: '2026-02-01T00:00:00Z' })], hasMore: false } };
    return { success: true, data: { requests: [row('p1', 'pending')], hasMore: false } };
  });
  decideOrgJoinRequest.mockResolvedValue({ success: true, data: { userId: 'u-p1', status: 'approved' } });
  clearOrgJoinRequest.mockResolvedValue({ success: true, data: { userId: 'u-d1' } });
});

describe('JoinRequestsPanel', () => {
  it('reads the pending page first and decides a request', async () => {
    render(<JoinRequestsPanel orgId="org-1" />);
    expect(await screen.findByText('p1@acme.com')).toBeInTheDocument();
    expect(listOrgJoinRequests).toHaveBeenCalledWith('org-1', expect.objectContaining({ status: 'pending', limit: JOIN_REQUEST_PAGE_SIZE, offset: 0 }));
    expect(screen.getByText(/lapses after 30 days/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    await waitFor(() => expect(decideOrgJoinRequest).toHaveBeenCalledWith('org-1', 'p1', 'deny'));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Request denied'));
    await waitFor(() => expect(listOrgJoinRequests).toHaveBeenCalledTimes(2));
  });

  it('the Denied tab lists denials and clears one', async () => {
    render(<JoinRequestsPanel orgId="org-1" />);
    await screen.findByText('p1@acme.com');
    fireEvent.click(screen.getByRole('tab', { name: /denied/i }));

    expect(await screen.findByText('d1@acme.com')).toBeInTheDocument();
    expect(lastOpts()).toEqual(expect.objectContaining({ status: 'denied', offset: 0 }));
    expect(screen.getByText(/cannot ask again until you clear/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /clear denial/i }));
    await waitFor(() => expect(clearOrgJoinRequest).toHaveBeenCalledWith('org-1', 'd1'));
    await waitFor(() => expect(success).toHaveBeenCalledWith(expect.stringMatching(/may ask again/i)));
  });

  it('says so when a list is empty', async () => {
    listOrgJoinRequests.mockResolvedValue({ success: true, data: { requests: [], hasMore: false } });
    render(<JoinRequestsPanel orgId="org-1" />);
    expect(await screen.findByText(/No pending join requests/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /denied/i }));
    expect(await screen.findByText(/No denied requests/i)).toBeInTheDocument();
    // No pager on a single empty page.
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  it('pages forward and back with offset + hasMore', async () => {
    listOrgJoinRequests.mockImplementation(async (_org: unknown, opts: unknown) => {
      const o = (opts ?? {}) as ListOpts;
      return o.offset
        ? { success: true, data: { requests: [row('p2', 'pending')], hasMore: false } }
        : { success: true, data: { requests: [row('p1', 'pending')], hasMore: true } };
    });
    render(<JoinRequestsPanel orgId="org-1" />);
    await screen.findByText('p1@acme.com');
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('p2@acme.com')).toBeInTheDocument();
    expect(lastOpts().offset).toBe(JOIN_REQUEST_PAGE_SIZE);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('p1@acme.com')).toBeInTheDocument();
  });

  it('steps back a page when the last row on a later page is decided', async () => {
    listOrgJoinRequests.mockImplementation(async (_org: unknown, opts: unknown) => {
      const o = (opts ?? {}) as ListOpts;
      return o.offset
        ? { success: true, data: { requests: [row('p2', 'pending')], hasMore: false } }
        : { success: true, data: { requests: [row('p1', 'pending')], hasMore: true } };
    });
    render(<JoinRequestsPanel orgId="org-1" />);
    await screen.findByText('p1@acme.com');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText('p2@acme.com');

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(decideOrgJoinRequest).toHaveBeenCalledWith('org-1', 'p2', 'approve'));
    expect(await screen.findByText('p1@acme.com')).toBeInTheDocument();
    expect(lastOpts().offset).toBe(0);
  });

  it('shows a refused action and keeps the list', async () => {
    clearOrgJoinRequest.mockRejectedValue(new Error('Join request not found'));
    render(<JoinRequestsPanel orgId="org-1" />);
    await screen.findByText('p1@acme.com');
    fireEvent.click(screen.getByRole('tab', { name: /denied/i }));
    fireEvent.click(await screen.findByRole('button', { name: /clear denial/i }));
    expect(await screen.findByText(/Join request not found/i)).toBeInTheDocument();
    expect(screen.getByText('d1@acme.com')).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be read', async () => {
    listOrgJoinRequests.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ success: true, data: { requests: [row('p1', 'pending')], hasMore: false } });
    render(<JoinRequestsPanel orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('p1@acme.com')).toBeInTheDocument();
  });

  it('readOnly shows the rows with every action disabled', async () => {
    render(<JoinRequestsPanel orgId="org-1" readOnly />);
    await screen.findByText('p1@acme.com');
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: /denied/i }));
    expect(await screen.findByRole('button', { name: /clear denial/i })).toBeDisabled();
  });
});
