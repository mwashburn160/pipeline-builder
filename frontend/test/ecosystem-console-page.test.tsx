// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem console (/dashboard/admin/ecosystem):
 *   - refuses outside the system org, and without plugins:moderate /
 *     publishers:verify, even for a deep link;
 *   - shows an MFA prompt instead of the console on a single-factor session;
 *   - a superadmin can add / remove Ecosystem Managers; any other holder sees
 *     the roster read-only.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EcosystemConsolePage from '../pages/dashboard/admin/ecosystem';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import { SYSTEM_ORG_ID } from '../src/lib/constants';
import { clearQueryCache } from '../src/lib/query-cache';

const authGuard = mockAuthGuard();
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

let aal: 1 | 2 | null = 2;
jest.mock('@/hooks/useSessionAssurance', () => ({ __esModule: true, useSessionAssurance: () => aal }));

const getOrganizationRoles = jest.fn<AnyFn>();
const getOrganizationMembers = jest.fn<AnyFn>();
const addRoleMember = jest.fn<AnyFn>();
const removeRoleMember = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a),
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
    addRoleMember: (...a: unknown[]) => addRoleMember(...a),
    removeRoleMember: (...a: unknown[]) => removeRoleMember(...a),
    // The governance panels (their behaviour is covered in ecosystem-console-panels.test.tsx).
    getEcosystemOverview: () => Promise.resolve({ success: true, data: {
      approvers: {
        minimum: 3,
        twoPersonMinimum: 2,
        moderate: { permission: 'plugins:moderate', count: { holders: 3, eligible: 3, superadmins: 1 }, belowMinimum: false, belowTwoPerson: false },
        verify: { permission: 'publishers:verify', count: { holders: 3, eligible: 3, superadmins: 1 }, belowMinimum: false, belowTwoPerson: false },
      },
      pending: { standard: 0, security: 0, secondApproval: 0, verify: 0 },
      bootstrap: { state: 'closed', openedAt: null, closedAt: null, reason: null },
      officialAutoApprovalEnabled: true, termsVersion: '1',
    } }),
    listEcosystemRequests: () => Promise.resolve({ success: true, data: { requests: [] } }),
    listEcosystemPublishers: () => Promise.resolve({ success: true, data: { publishers: [] } }),
    listEcosystemListings: () => Promise.resolve({ success: true, data: { listings: [] } }),
    listAutoRules: () => Promise.resolve({ success: true, data: { rules: [] } }),
    listReservedNames: () => Promise.resolve({ success: true, data: { names: [{ name: 'trivy', reason: null, publisherId: null, createdAt: '2026-09-01T00:00:00Z' }] } }),
  },
}));

const holder = { id: 'u-mod', username: 'moddy', email: 'mod@example.com' };
const rolesResponse = (members = [holder]) => ({
  success: true,
  data: {
    roles: [
      { id: 'r-admin', name: 'Admin', grantsRole: 'admin', permissions: [], system: true, members: [] },
      { id: 'r-eco', name: 'Ecosystem Manager', grantsRole: 'member', permissions: ['plugins:moderate'], system: true, members },
    ],
    pagination: { total: 2, offset: 0, limit: 2, hasMore: false },
  },
});

const systemUser = { id: 'u1', organizationId: SYSTEM_ORG_ID };

beforeEach(() => {
  clearQueryCache();
  aal = 2;
  mockAuthGuard({ user: { ...systemUser, permissions: ['plugins:moderate'] } });
  getOrganizationRoles.mockReset().mockResolvedValue(rolesResponse());
  getOrganizationMembers.mockReset().mockResolvedValue({
    success: true,
    data: {
      members: [
        { id: 'u-mod', username: 'moddy', email: 'mod@example.com' },
        { id: 'u-new', username: 'newbie', email: 'new@example.com' },
      ],
      pagination: { total: 2, offset: 0, limit: 200, hasMore: false },
    },
  });
  addRoleMember.mockReset().mockResolvedValue({ success: true, data: { userId: 'u-new' } });
  removeRoleMember.mockReset().mockResolvedValue({ success: true, data: { message: 'ok' } });
});

const openManagers = async () => {
  fireEvent.click(await screen.findByRole('tab', { name: /ecosystem managers/i }));
};

describe('Ecosystem console — governance boundary', () => {
  it('refuses outside the system org, even with the permission', () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'tenant-org', permissions: ['plugins:moderate'] } });
    render(<EcosystemConsolePage />);
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(getOrganizationRoles).not.toHaveBeenCalled();
  });

  it('refuses a superadmin who has switched into a tenant org', () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'tenant-org', isSuperAdmin: true }, isSuperAdmin: true });
    render(<EcosystemConsolePage />);
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
  });

  it('refuses a system-org member without either ecosystem permission', () => {
    mockAuthGuard({ user: { ...systemUser, permissions: ['plugins:read'] } });
    render(<EcosystemConsolePage />);
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
  });

  it('opens for publishers:verify alone', async () => {
    mockAuthGuard({ user: { ...systemUser, permissions: ['publishers:verify'] } });
    render(<EcosystemConsolePage />);
    expect(await screen.findByRole('tab', { name: /publish queue/i })).toBeInTheDocument();
    expect(await screen.findByTestId('queue-overview')).toBeInTheDocument();
    expect(await screen.findByText(/no requests match these filters/i)).toBeInTheDocument();
  });

  it('has a tab per governance panel', async () => {
    render(<EcosystemConsolePage />);
    fireEvent.click(await screen.findByRole('tab', { name: /publisher verification/i }));
    expect(await screen.findByText(/no pending applications/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^listings$/i }));
    expect(await screen.findByText(/no listings match/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /auto-approval rules/i }));
    expect(await screen.findByText(/every request waits for a human decision/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /reserved names/i }));
    expect(await screen.findByTestId('reserved-trivy')).toBeInTheDocument();
  });
});

describe('Ecosystem console — assurance', () => {
  it('shows the enrol prompt (not the console) on a single-factor session with no factor', () => {
    aal = 1;
    render(<EcosystemConsolePage />);
    expect(screen.getByText(/two-factor sign-in required/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /set up two-factor/i })).toHaveAttribute('href', expect.stringContaining('/dashboard/security'));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(getOrganizationRoles).not.toHaveBeenCalled();
  });

  it('asks an account that already has a factor to sign in again with it', () => {
    aal = 1;
    mockAuthGuard({
      user: { ...systemUser, permissions: ['plugins:moderate'], authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: false, providers: [] } },
    });
    render(<EcosystemConsolePage />);
    expect(screen.getByText(/sign in again using your passkey/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open security settings/i })).toBeInTheDocument();
  });
});

describe('Ecosystem console — Ecosystem Managers', () => {
  it('a superadmin can add a system-org member and remove a holder', async () => {
    mockAuthGuard({ user: { ...systemUser, isSuperAdmin: true }, isSuperAdmin: true });
    render(<EcosystemConsolePage />);
    await openManagers();

    expect(await screen.findByText('moddy')).toBeInTheDocument();
    const select = await screen.findByRole('combobox', { name: /member to add/i });
    // Existing holders are not offered again.
    await waitFor(() => expect(screen.getByRole('option', { name: /newbie/ })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /moddy/ })).not.toBeInTheDocument();
    expect(getOrganizationRoles).toHaveBeenCalledWith(SYSTEM_ORG_ID, undefined, expect.anything());

    fireEvent.change(select, { target: { value: 'u-new' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(addRoleMember).toHaveBeenCalledWith(SYSTEM_ORG_ID, 'r-eco', { userId: 'u-new' }));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /remove moddy/i }));
    await waitFor(() => expect(removeRoleMember).toHaveBeenCalledWith(SYSTEM_ORG_ID, 'r-eco', 'u-mod'));
  });

  it('surfaces a refused assignment as an error toast', async () => {
    mockAuthGuard({ user: { ...systemUser, isSuperAdmin: true }, isSuperAdmin: true });
    addRoleMember.mockResolvedValue({ success: false, message: 'Only superadmins can assign this role' });
    render(<EcosystemConsolePage />);
    await openManagers();
    const select = await screen.findByRole('combobox', { name: /member to add/i });
    await waitFor(() => expect(screen.getByRole('option', { name: /newbie/ })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: 'u-new' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith('Only superadmins can assign this role'));
  });

  it('a read-only impersonation still sees the console, with no write controls', async () => {
    mockAuthGuard({ user: { ...systemUser, isSuperAdmin: true }, isSuperAdmin: true, isReadOnly: true });
    render(<EcosystemConsolePage />);
    await openManagers();
    expect(await screen.findByText('moddy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('a non-superadmin holder sees the roster read-only', async () => {
    render(<EcosystemConsolePage />);
    await openManagers();
    expect(await screen.findByText('moddy')).toBeInTheDocument();
    expect(screen.getByText(/only superadmins can assign/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(getOrganizationMembers).not.toHaveBeenCalled();
  });

  it('says so when the built-in role is missing', async () => {
    getOrganizationRoles.mockResolvedValue({ success: true, data: { roles: [], pagination: { total: 0, offset: 0, limit: 0, hasMore: false } } });
    render(<EcosystemConsolePage />);
    await openManagers();
    expect(await screen.findByText(/role not found/i)).toBeInTheDocument();
  });

  it('shows an empty roster', async () => {
    getOrganizationRoles.mockResolvedValue(rolesResponse([]));
    render(<EcosystemConsolePage />);
    await openManagers();
    expect(await screen.findByText(/no ecosystem managers/i)).toBeInTheDocument();
  });
});
