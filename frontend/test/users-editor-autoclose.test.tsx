// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * After a successful edit the Users page closes the editor 1.5s later (so the
 * success message is readable). That delayed close must only ever close the
 * editor it was scheduled for: opening another user's editor in the meantime
 * must not be closed out from under the operator.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent } from '@testing-library/react';
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

// The editor reduced to what this test drives: who is open, a field, and Save.
jest.mock('@/components/users/EditUserModal', () => ({
  __esModule: true,
  EditUserModal: ({ editingUser, onEditUsernameChange, onSubmit }: {
    editingUser: { email: string } | null;
    onEditUsernameChange: (v: string) => void;
    onSubmit: () => void;
  }) => (editingUser ? (
    <div>
      <p>Editing {editingUser.email}</p>
      <button type="button" onClick={() => onEditUsernameChange('renamed')}>Rename</button>
      <button type="button" onClick={onSubmit}>Save</button>
    </div>
  ) : null),
}));

const users = [
  { id: 'a', username: 'alice', email: 'alice@acme.com', role: 'member', organizationId: '' },
  { id: 'b', username: 'bob', email: 'bob@acme.com', role: 'member', organizationId: '' },
];
const mockUpdateUserById = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const overrides: Record<string, unknown> = {
    listUsers: () => Promise.resolve({ success: true, data: { users, pagination: { total: 2, limit: 25, offset: 0, hasMore: false } } }),
    updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
  };
  const api = new Proxy({}, { get: (_t, k: string) => overrides[k] ?? (() => Promise.resolve({ success: true, data: {} })) });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

/** Let the mocked update resolve and the page apply its result (microtasks only). */
async function flushSave() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

/** These render the full users page through a step-up confirm — far past
 *  jest's 5s default once the suite runs in parallel. */
const SLOW_PAGE_TEST_MS = 30_000;

describe('UsersPage editor auto-close', () => {
  beforeEach(() => {
    mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' } });
    mockUpdateUserById.mockResolvedValue({ success: true, data: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("a close scheduled for one user's editor does not close another user's editor", async () => {
    render(<UsersPage />);
    const editButtons = await screen.findAllByRole('button', { name: 'Edit' });

    // Save alice.
    fireEvent.click(editButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    jest.useFakeTimers(); // before the save completes, so the delayed close is a fake timer
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await flushSave();
    expect(mockUpdateUserById).toHaveBeenCalledWith('a', expect.anything(), 'step-up-token');
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    // Within the 1.5s window, open bob.
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    expect(screen.getByText('Editing bob@acme.com')).toBeInTheDocument();

    act(() => { jest.advanceTimersByTime(2000); });
    expect(screen.getByText('Editing bob@acme.com')).toBeInTheDocument();
    // Rendering the whole users page twice over, through a step-up confirm,
    // runs 3-4s on its own and overran the 5s default under a parallel suite.
  }, SLOW_PAGE_TEST_MS);

  it("still closes the saved user's editor after the delay", async () => {
    render(<UsersPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    jest.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await flushSave();
    expect(mockUpdateUserById).toHaveBeenCalled();
    expect(screen.getByText('Editing alice@acme.com')).toBeInTheDocument();

    act(() => { jest.advanceTimersByTime(2000); });
    expect(screen.queryByText('Editing alice@acme.com')).not.toBeInTheDocument();
  }, SLOW_PAGE_TEST_MS);
});
