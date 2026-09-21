// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Opening a user on the Users page re-reads them (`GET /users/:id`) instead of
 * trusting the list row, which can be minutes stale: the editor shows — and the
 * save diffs against — the user's CURRENT record. A failed read degrades to the
 * row with a notice rather than blocking the editor.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import UsersPage from '../pages/dashboard/users';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = { query: {}, pathname: '/dashboard/users', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
  ),
}));

// The editor reduced to what this test reads: the record it holds and whether
// the fresh read is still in flight.
jest.mock('@/components/users/EditUserModal', () => ({
  __esModule: true,
  EditUserModal: ({ editingUser, editEmail, detailLoading, detailError, onSubmit }: {
    editingUser: { email: string } | null;
    editEmail: string;
    detailLoading?: boolean;
    detailError?: string | null;
    onSubmit: () => void;
  }) => (editingUser ? (
    <div>
      <p>Editing {editEmail}</p>
      {detailLoading && <p>loading-detail</p>}
      {detailError && <p>{detailError}</p>}
      <button type="button" onClick={onSubmit}>Save</button>
    </div>
  ) : null),
}));

const users = [{ id: 'a', username: 'alice', email: 'alice@old.example', role: 'member', organizationId: '' }];
const mockGetUser = jest.fn<AnyFn>();
const mockUpdateUserById = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const overrides: Record<string, unknown> = {
    listUsers: () => Promise.resolve({ success: true, data: { users, pagination: { total: 1, limit: 25, offset: 0, hasMore: false } } }),
    getUser: (...a: unknown[]) => mockGetUser(...a),
    updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
  };
  const api = new Proxy({}, { get: (_t, k: string) => overrides[k] ?? (() => Promise.resolve({ success: true, data: {} })) });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' } });
});

describe('UsersPage — the editor shows the user as they are now', () => {
  it('re-reads the user and replaces the stale row', async () => {
    mockGetUser.mockResolvedValue({
      success: true,
      data: { user: { id: 'a', username: 'alice', email: 'alice@new.example', role: 'admin', isEmailVerified: true } },
    });
    render(<UsersPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);

    expect(mockGetUser).toHaveBeenCalledWith('a', expect.objectContaining({ signal: expect.anything() }));
    expect(await screen.findByText('Editing alice@new.example')).toBeInTheDocument();
    expect(screen.queryByText('loading-detail')).not.toBeInTheDocument();
  });

  it('diffs a save against the fresh record, so an unchanged field is not re-sent', async () => {
    mockGetUser.mockResolvedValue({
      success: true,
      data: { user: { id: 'a', username: 'alice', email: 'alice@new.example', role: 'member', isEmailVerified: true } },
    });
    render(<UsersPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    await screen.findByText('Editing alice@new.example');

    // Nothing was changed relative to the CURRENT record → nothing to save.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('button', { name: 'Confirm password' })).not.toBeInTheDocument();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('falls back to the row, and says so, when the read fails', async () => {
    mockGetUser.mockRejectedValue(new Error('network down'));
    render(<UsersPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);

    await waitFor(() => expect(screen.getByText(/network down/)).toBeInTheDocument());
    expect(screen.getByText('Editing alice@old.example')).toBeInTheDocument();
  });
});
