// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Access requests page.
 *
 * The properties that matter:
 *   - APPROVE is confirmed, and the confirmation says exactly what is granted.
 *   - END SESSION is confirmed once (it can't be undone) but never stepped up —
 *     stopping access is never harder than allowing it.
 *   - DENY acts immediately.
 *   - Each list is paged server-side.
 *   - A request someone else already answered is reported, not shown as an error.
 *   - During read-only impersonation every action is disabled (it would 403).
 *   - The operator-written reason renders as TEXT, never markup.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { READ_ONLY_REASON } from '@/components/ui/ReadOnlyNotice';
import AccessRequestsPage from '../pages/dashboard/access-requests';
import { ApiError } from '../src/lib/api/errors';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';

const authGuard = mockAuthGuard({ user: { id: 'me', organizationId: 'org-1' } });
const toast = pageToast;

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

// A minimal ConfirmDialog: renders its body and the two actions inline, so the
// test reads what the real dialog would say without the portal machinery.
jest.mock('@/components/ui/ConfirmDialog', () => ({
  __esModule: true,
  ConfirmDialog: ({ title, children, confirmLabel, onConfirm, onCancel }: {
    title: string; children: React.ReactNode; confirmLabel?: string; onConfirm: () => void; onCancel: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      {children}
      <button type="button" onClick={onConfirm}>{`Confirm ${confirmLabel ?? ''}`}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
  ),
}));

const listImpersonationRequests = jest.fn<AnyFn>();
const decideImpersonationRequest = jest.fn<AnyFn>();
const revokeImpersonationSession = jest.fn<AnyFn>();
const redeemImpersonationRequest = jest.fn<AnyFn>();
const startImpersonation = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listImpersonationRequests: (...a: unknown[]) => listImpersonationRequests(...a),
    decideImpersonationRequest: (...a: unknown[]) => decideImpersonationRequest(...a),
    revokeImpersonationSession: (...a: unknown[]) => revokeImpersonationSession(...a),
    redeemImpersonationRequest: (...a: unknown[]) => redeemImpersonationRequest(...a),
    startImpersonation: (...a: unknown[]) => startImpersonation(...a),
  },
}));

const pending = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  status: 'pending',
  breakglass: false,
  reason: 'Ticket #42 — dashboard looks empty',
  requester: { id: 'op', name: 'op-jane' },
  target: { id: 'me', name: 'me' },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  ...over,
});
const live = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1',
  status: 'consumed',
  breakglass: false,
  requester: { id: 'op', name: 'op-jane' },
  target: { id: 'me', name: 'me' },
  createdAt: new Date().toISOString(),
  expiresAt: new Date().toISOString(),
  consumedAt: new Date().toISOString(),
  ...over,
});

function serve({ toDecide = [] as unknown[], sessions = [] as unknown[], mine = [] as unknown[] } = {}, totals: Record<string, number> = {}) {
  listImpersonationRequests.mockImplementation(async (view: string, page?: { limit?: number; offset?: number }) => {
    const requests = view === 'to-decide' ? toDecide : view === 'sessions' ? sessions : mine;
    const limit = page?.limit ?? 10;
    const offset = page?.offset ?? 0;
    const total = totals[view] ?? requests.length;
    return { success: true, data: { requests, pagination: { total, offset, limit, hasMore: offset + limit < total } } };
  });
}

beforeEach(() => {
  listImpersonationRequests.mockReset();
  decideImpersonationRequest.mockReset().mockResolvedValue({ success: true });
  revokeImpersonationSession.mockReset().mockResolvedValue({ success: true });
  redeemImpersonationRequest.mockReset();
  startImpersonation.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  authGuard.isReadOnly = false;
  serve();
});

describe('AccessRequestsPage — deciding', () => {
  it('shows who wants to view which account, and why', async () => {
    serve({ toDecide: [pending()] });
    render(<AccessRequestsPage />);

    expect(await screen.findByText('op-jane')).toBeInTheDocument();
    expect(screen.getByText('your account')).toBeInTheDocument();
    expect(screen.getByText(/Ticket #42/)).toBeInTheDocument();
  });

  it('APPROVE asks first, and the confirmation states exactly what is granted', async () => {
    serve({ toDecide: [pending()] });
    render(<AccessRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    // Not approved yet — only a confirmation is open.
    expect(decideImpersonationRequest).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/15 minutes/);
    expect(dialog).toHaveTextContent(/view-only/i);
    expect(dialog).toHaveTextContent(/end the session at any time/i);

    fireEvent.click(screen.getByRole('button', { name: /Confirm Approve/ }));
    await waitFor(() => expect(decideImpersonationRequest).toHaveBeenCalledWith('req-1', true));
  });

  it('DENY acts immediately, with no confirmation', async () => {
    serve({ toDecide: [pending()] });
    render(<AccessRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(decideImpersonationRequest).toHaveBeenCalledWith('req-1', false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a request someone else already answered — not as an error', async () => {
    serve({ toDecide: [pending()] });
    decideImpersonationRequest.mockRejectedValue(new ApiError('Request is no longer pending', 409, 'IMP_ALREADY_DECIDED'));
    render(<AccessRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    // And it refreshes, so the stale row doesn't linger looking actionable.
    await waitFor(() => expect(listImpersonationRequests.mock.calls.length).toBeGreaterThan(2));
  });

  it('marks emergency access and says the viewer is the second administrator', async () => {
    serve({ toDecide: [pending({ breakglass: true })] });
    render(<AccessRequestsPage />);

    expect(await screen.findByText(/you are the second administrator/i)).toBeInTheDocument();
  });

  it('renders the operator-written reason as TEXT, never markup', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1">';
    serve({ toDecide: [pending({ reason: hostile })] });
    const { container } = render(<AccessRequestsPage />);

    expect(await screen.findByText((t) => t.includes('onerror'))).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('says so when nothing is waiting', async () => {
    render(<AccessRequestsPage />);
    expect(await screen.findByText(/nothing is waiting for you/i)).toBeInTheDocument();
  });
});

describe('AccessRequestsPage — live sessions', () => {
  it('END SESSION confirms once — no step-up — then ends it', async () => {
    serve({ sessions: [live()] });
    render(<AccessRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'End session' }));

    // Only a confirmation is open; it says the ending can't be undone.
    expect(revokeImpersonationSession).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent(/can't be undone/i);
    expect(screen.queryByRole('button', { name: 'Confirm password' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Confirm End session/ }));
    await waitFor(() => expect(revokeImpersonationSession).toHaveBeenCalledWith('sess-1'));
  });

  it('cancelling END SESSION leaves the session running', async () => {
    serve({ sessions: [live()] });
    render(<AccessRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'End session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revokeImpersonationSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does NOT claim the session is over when other services could not be told', async () => {
    serve({ sessions: [live()] });
    revokeImpersonationSession.mockResolvedValue({ success: true, data: { requestId: 'sess-1', status: 'revoked', revokedEverywhere: false } });
    render(<AccessRequestsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'End session' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm End session/ }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/other services/i)));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says so when no one is viewing an account', async () => {
    render(<AccessRequestsPage />);
    expect(await screen.findByText(/no one is viewing an account right now/i)).toBeInTheDocument();
  });
});

describe('AccessRequestsPage — read-only impersonation', () => {
  it('disables every action and explains why', async () => {
    authGuard.isReadOnly = true;
    serve({ toDecide: [pending()], sessions: [live()] });
    render(<AccessRequestsPage />);

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End session' })).toBeDisabled();
    for (const name of ['Approve', 'Deny', 'End session']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', READ_ONLY_REASON);
    }
    expect(screen.getByText('Read-only session')).toBeInTheDocument();
  });
});


describe('AccessRequestsPage — your requests', () => {
  const approved = () => pending({
    id: 'mine-1', status: 'approved', requester: { id: 'me', name: 'me' }, target: { id: 'cust', name: 'customer@acme.com' },
  });

  it('hides the section for people who never ask for access', async () => {
    render(<AccessRequestsPage />);
    await screen.findByText(/nothing is waiting for you/i);
    expect(screen.queryByText('Your requests')).not.toBeInTheDocument();
  });

  it('opens an approved request after the password check, keeping the request id', async () => {
    serve({ mine: [approved()] });
    redeemImpersonationRequest.mockResolvedValue({
      success: true, data: { accessToken: 'imp.jwt', requestId: 'mine-1', status: 'consumed' },
    });
    render(<AccessRequestsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open session' }));
    expect(redeemImpersonationRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));

    await waitFor(() => expect(redeemImpersonationRequest).toHaveBeenCalledWith('mine-1', 'step-up-token'));
    // The request id is kept so "Stop impersonating" can end it on the server.
    expect(startImpersonation).toHaveBeenCalledWith('imp.jwt', 'mine-1');
  });

  it('offers no Open button for a request that is still waiting', async () => {
    serve({ mine: [{ ...approved(), status: 'pending' }] });
    render(<AccessRequestsPage />);

    expect(await screen.findByText(/waiting for approval/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open session' })).not.toBeInTheDocument();
  });
});

describe('AccessRequestsPage — paging', () => {
  it('asks each list for one page, and pages on demand', async () => {
    serve({ toDecide: [pending()] }, { 'to-decide': 43 });
    render(<AccessRequestsPage />);

    // The pending count is the server's total, not the page length.
    expect(await screen.findByText('43 pending')).toBeInTheDocument();
    expect(listImpersonationRequests).toHaveBeenCalledWith('to-decide', { limit: 25, offset: 0 }, expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(listImpersonationRequests).toHaveBeenCalledWith('to-decide', { limit: 25, offset: 25 }, expect.anything()));
  });

  it('shows no pager when everything fits on one page', async () => {
    serve({ toDecide: [pending()] });
    render(<AccessRequestsPage />);
    await screen.findByText('op-jane');
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });

  it('offers a retry when a list fails to load', async () => {
    listImpersonationRequests.mockRejectedValue(new Error('down'));
    render(<AccessRequestsPage />);
    expect(await screen.findAllByRole('button', { name: /retry/i })).not.toHaveLength(0);
  });
});
