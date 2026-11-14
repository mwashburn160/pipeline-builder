// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Users page writes (sysadmin): the editor sends ONLY changed fields (an emptied
 * org becomes `organizationId: null`), refuses bad input before the step-up, and
 * the create form validates and scopes roles to an org.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
const mockRouter = { query: {}, pathname: '/dashboard/users', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
  ),
}));
jest.mock('@/components/users/SysadminGrantHistory', () => ({ __esModule: true, SysadminGrantHistory: () => null }));
jest.mock('@/components/admin/FeatureOverridesEditor', () => ({ __esModule: true, FeatureOverridesEditor: () => null }));
jest.mock('@/components/ui/OrgPicker', () => ({
  __esModule: true,
  OrgPicker: ({ id, value, onChange, 'aria-label': aria }: { id?: string; value: string; onChange: (v: string) => void; 'aria-label'?: string }) => (
    <select id={id} aria-label={aria} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— No organization —</option>
      <option value="org-a">Alpha</option>
    </select>
  ),
}));

const users = [{ id: 'a', username: 'alice', email: 'alice@acme.com', role: 'member', organizationId: 'org-a', organizationName: 'Alpha', isEmailVerified: true }];
const updateUserById = jest.fn<AnyFn>();
const createUser = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const overrides: Record<string, unknown> = {
    listUsers: () => Promise.resolve({ success: true, data: { users, pagination: { total: 1, limit: 25, offset: 0, hasMore: false } } }),
    getUserById: () => Promise.resolve({ success: true, data: { user: users[0] } }),
    getOrganizationRoles: () => Promise.resolve({ success: true, data: { roles: [{ id: 'r1', name: 'Deployers' }], pagination: { total: 1 } } }),
    updateUserById: (...a: unknown[]) => updateUserById(...a),
    createUser: (...a: unknown[]) => createUser(...a),
  };
  const api = new Proxy({}, { get: (_t, k: string) => overrides[k] ?? (() => Promise.resolve({ success: true, data: {} })) });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

import UsersPage from '../pages/dashboard/users';

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const SLOW = 30_000;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' }, can: () => true });
  updateUserById.mockResolvedValue({ success: true, data: {} });
  createUser.mockResolvedValue({ success: true, data: {} });
});

async function openEditor() {
  render(<UsersPage />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
  await flush();
  return screen.getByRole('dialog');
}

describe('users: edit', () => {
  it('refuses a short username, an empty email, a short password and "no changes"', async () => {
    const dialog = await openEditor();
    const save = within(dialog).getByRole('button', { name: 'Save Changes' });
    fireEvent.click(save);
    expect(await within(dialog).findByText('No changes to save')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'a' } });
    fireEvent.click(save);
    expect(await within(dialog).findByText(/Username must be at least 2/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: ' ' } });
    fireEvent.click(save);
    expect(await within(dialog).findByText('Email is required')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'alice@acme.com' } });
    fireEvent.change(within(dialog).getByPlaceholderText('Minimum 8 characters'), { target: { value: 'short' } });
    fireEvent.click(save);
    expect(await within(dialog).findByText(/Password must be at least 8/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm password' })).not.toBeInTheDocument();
    expect(updateUserById).not.toHaveBeenCalled();
  }, SLOW);

  it('sends only the changed fields after step-up; an emptied org is null', async () => {
    const dialog = await openEditor();
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'a2@acme.com' } });
    fireEvent.change(within(dialog).getByLabelText('Organization'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(updateUserById).toHaveBeenCalledWith('a', { email: 'a2@acme.com', organizationId: null, role: 'admin' }, 'step-up-token'));
  }, SLOW);
});

describe('users: create', () => {
  it('validates, then creates with roles only alongside an org', async () => {
    render(<UsersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add User/ }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create User' });
    fireEvent.click(create);
    expect(await within(dialog).findByText(/Username must be at least 2/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'carol' } });
    fireEvent.click(create);
    expect(await within(dialog).findByText('Email is required')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'carol@acme.com' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.click(create);
    expect(await within(dialog).findByText(/Password must be at least 8/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'longenough1' } });
    fireEvent.change(within(dialog).getByLabelText('Organization'), { target: { value: 'org-a' } });
    fireEvent.click(await within(dialog).findByLabelText(/Deployers/));
    fireEvent.click(create);
    await waitFor(() => expect(createUser).toHaveBeenCalledWith({
      username: 'carol', email: 'carol@acme.com', password: 'longenough1', organizationId: 'org-a', role: 'member', roleIds: ['r1'],
    }));
  }, SLOW);
});
