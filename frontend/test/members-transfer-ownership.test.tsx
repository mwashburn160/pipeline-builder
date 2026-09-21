// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Members → transfer ownership.
 *
 * Destructive (the acting owner is demoted and loses owner-only controls) AND
 * step-up gated, so the house rule applies: ONE dialog that states what is lost
 * and takes the factor, never a confirm modal in front of a step-up modal. The
 * pair is what this file pins — it used to render `TransferOwnershipModal` and
 * then `StepUpModal`, asking the same person the same question twice.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import type { OrganizationMember } from '@/types';
import MembersPage from '../pages/dashboard/members';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = { query: {}, pathname: '/dashboard/members', asPath: '/dashboard/members', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const refreshUser = jest.fn<AnyFn>().mockResolvedValue(undefined);
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: { organizationId: 'org-1' }, organizations: [], refreshUser, switchOrganization: jest.fn<AnyFn>() }),
}));

// Renders `title` + `details`: with no confirm dialog in front of it, this is
// the only place the cost of the action can be stated.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, title, details, onConfirmed }: {
    action: string; title?: string; details?: React.ReactNode; onConfirmed: (t: string) => void;
  }) => (
    <div role="dialog" aria-label={title ?? 'step-up'}>
      <p>{action}</p>
      {details}
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Verify</button>
    </div>
  ),
}));

const mockApi: Record<string, jest.Mock<AnyFn>> = {};
jest.mock('@/lib/api', () => {
  const api = new Proxy({}, {
    get: (_t, key: string) => mockApi[key] ?? (() => Promise.resolve({ success: true, data: {} })),
  });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

const BEE: OrganizationMember = {
  id: 'u2', username: 'bee', email: 'bee@acme.test', role: 'member',
  isOwner: false, isActive: true, isEmailVerified: true, createdAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  mockAuthGuard({
    isAdmin: true,
    // The affordance is backend-gated to the owner, so the viewer must BE one.
    user: { id: 'me', organizationId: 'org-1', role: 'owner', permissions: ['members:manage'] },
    can: (p: string) => p === 'members:manage',
  });
  mockApi.getOrganizationMembers = jest.fn<AnyFn>().mockResolvedValue({
    success: true, data: { members: [BEE], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } },
  });
});

/** Click the crown on Bee's row. */
async function openTransfer() {
  render(<MembersPage />);
  fireEvent.click(await screen.findByRole('button', { name: /transfer organization ownership to bee/i }));
}

describe('transfer ownership is one dialog', () => {
  it('opens a single dialog that names the new owner and what the current one loses', async () => {
    await openTransfer();
    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(1);

    const dialog = screen.getByRole('dialog', { name: /transfer ownership\?/i });
    expect(dialog).toHaveTextContent(/bee/i);
    expect(dialog).toHaveTextContent(/demoted to admin/i);
    // Nothing is written until the factor is supplied.
    expect(mockApi.transferOrgOwnership).toBeUndefined();
  });

  it('the same dialog takes the factor and forwards its token to the PATCH', async () => {
    mockApi.transferOrgOwnership = jest.fn<AnyFn>().mockResolvedValue({ success: true });
    await openTransfer();

    const dialog = await screen.findByRole('dialog', { name: /transfer ownership\?/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(mockApi.transferOrgOwnership).toHaveBeenCalledWith('org-1', 'u2', 'step-up-token'));
    // The acting user is no longer owner — their session must be re-read.
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
    expect(pageToast.success).toHaveBeenCalledWith('Ownership transferred to bee');
  });

  it('a refusal surfaces on the page and closes the dialog', async () => {
    mockApi.transferOrgOwnership = jest.fn<AnyFn>().mockResolvedValue({ success: false, message: 'Not the owner' });
    await openTransfer();

    const dialog = await screen.findByRole('dialog', { name: /transfer ownership\?/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText(/not the owner/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /transfer ownership\?/i })).not.toBeInTheDocument());
  });

  it('is not offered to a non-owner', async () => {
    mockAuthGuard({
      isAdmin: true,
      user: { id: 'me', organizationId: 'org-1', role: 'admin', permissions: ['members:manage'] },
      can: (p: string) => p === 'members:manage',
    });
    render(<MembersPage />);
    await screen.findByText('bee');
    expect(screen.queryByRole('button', { name: /transfer organization ownership/i })).not.toBeInTheDocument();
  });
});
