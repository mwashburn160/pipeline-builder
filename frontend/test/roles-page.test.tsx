// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Roles page: the role list is paged server-side (each role still carries its
 * members), a load failure offers a retry instead of an empty page, and a
 * read-only impersonation still READS the roles — the page gate let it in, and
 * only the write controls are withheld.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RolesPage from '../pages/dashboard/roles';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getOrganizationRoles = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a) },
}));

const role = (i: number) => ({
  id: `r${i}`, name: `Role ${i}`, grantsRole: 'member', permissions: [], system: false,
  members: [{ id: `u${i}`, username: `user${i}`, email: `user${i}@x.io` }],
});

function serve(total: number, pageRoles = [role(1), role(2)]) {
  getOrganizationRoles.mockImplementation(async (_org: string, page: { limit: number; offset: number }) => ({
    success: true,
    data: { roles: pageRoles, pagination: { total, offset: page.offset, limit: page.limit, hasMore: page.offset + page.limit < total } },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ can: (p: string) => p === 'roles:manage' });
});

describe('RolesPage', () => {
  it('reads one page of roles and renders their members', async () => {
    serve(2);
    render(<RolesPage />);
    expect(await screen.findByText('user1')).toBeInTheDocument();
    expect(getOrganizationRoles).toHaveBeenCalledWith('org-1', { limit: 20, offset: 0 }, expect.anything());
    // Everything fits — no pager.
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });

  it('pages when the org has more roles than fit', async () => {
    serve(45);
    render(<RolesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(getOrganizationRoles).toHaveBeenLastCalledWith('org-1', { limit: 20, offset: 20 }, expect.anything()));
  });

  it('offers a retry when the roles fail to load', async () => {
    getOrganizationRoles.mockRejectedValueOnce(new Error('boom'));
    render(<RolesPage />);
    const retry = await screen.findByRole('button', { name: /retry/i });

    serve(2);
    fireEvent.click(retry);
    expect(await screen.findByText('user1')).toBeInTheDocument();
  });

  it('still shows the roles during a read-only impersonation, without write controls', async () => {
    mockAuthGuard({ isReadOnly: true, can: () => false });
    serve(2);
    render(<RolesPage />);
    expect(await screen.findByText('user1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new role/i })).not.toBeInTheDocument();
  });
});
