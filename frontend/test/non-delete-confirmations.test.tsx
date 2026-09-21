// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-delete actions must not borrow the DELETE confirmation: replaying a DLQ
 * job, retrying a failed build and deactivating a member each confirm with
 * their own verb (DeleteConfirmModal would ask "Are you sure you want to
 * delete…" with a Delete button).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import BuildQueuePage from '../pages/dashboard/build-queue';
import MembersPage from '../pages/dashboard/members';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = { query: {}, pathname: '/dashboard/x', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ organizations: [{ id: 'org-1', name: 'Acme' }], refreshUser: jest.fn<AnyFn>(), switchOrganization: jest.fn<AnyFn>() }),
}));

/** Every api method resolves to an empty success unless a test overrides it. */
const mockApiOverrides: Record<string, jest.Mock<AnyFn>> = {};
jest.mock('@/lib/api', () => {
  const api = new Proxy({}, {
    get: (_t, key: string) => mockApiOverrides[key] ?? (() => Promise.resolve({ success: true, data: {} })),
  });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

function expectNoDeleteWording(dialog: HTMLElement) {
  expect(within(dialog).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  expect(dialog).not.toHaveTextContent(/delete/i);
}

describe('build queue', () => {
  beforeEach(() => {
    mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' } });
    mockApiOverrides.getQueueStatus = jest.fn<AnyFn>().mockResolvedValue({
      data: { waiting: 0, active: 0, completed: 0, failed: 1, delayed: 0, dlq: { waiting: 1, active: 0, failed: 0, delayed: 0 } },
    });
    mockApiOverrides.getQueueFailed = jest.fn<AnyFn>().mockResolvedValue({ data: { jobs: [{ id: 'failed-job-123456', pluginName: 'lint' }] } });
    mockApiOverrides.getQueueDlq = jest.fn<AnyFn>().mockResolvedValue({ data: { jobs: [{ id: 'dlq-job-9876543', pluginName: 'scan' }] } });
    mockApiOverrides.retryFailedJob = jest.fn<AnyFn>().mockResolvedValue({ data: { newJobId: 'n1' } });
    mockApiOverrides.replayDlqJob = jest.fn<AnyFn>().mockResolvedValue({ data: { newJobId: 'n2' } });
  });

  it('confirms a failed-build retry as a retry', async () => {
    render(<BuildQueuePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View Failed Jobs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Retry failed build?')).toBeInTheDocument();
    expectNoDeleteWording(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry build' }));
    await waitFor(() => expect(mockApiOverrides.retryFailedJob).toHaveBeenCalledWith('failed-job-123456'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('confirms a DLQ replay as a replay', async () => {
    render(<BuildQueuePage />);
    fireEvent.click(await screen.findByRole('button', { name: /view dlq/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replay' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Replay DLQ job?')).toBeInTheDocument();
    expectNoDeleteWording(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(mockApiOverrides.replayDlqJob).toHaveBeenCalledWith('dlq-job-9876543'));
  });
});

describe('members', () => {
  beforeEach(() => {
    mockAuthGuard({
      isAdmin: true,
      isOrgAdminUser: true,
      user: { id: 'me', organizationId: 'org-1', permissions: ['members:manage'] },
      can: (p: string) => p === 'members:manage',
    });
    mockApiOverrides.getOrganizationMembers = jest.fn<AnyFn>().mockResolvedValue({
      success: true,
      data: {
        members: [{ id: 'm1', username: 'trinity', email: 't@acme.com', role: 'member', isActive: true, joinedAt: '2026-01-01' }],
        pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
      },
    });
    mockApiOverrides.deactivateMember = jest.fn<AnyFn>().mockResolvedValue({ success: true });
  });

  it('confirms deactivation as a deactivation', async () => {
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate trinity' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Deactivate member?')).toBeInTheDocument();
    expectNoDeleteWording(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApiOverrides.deactivateMember).toHaveBeenCalledWith('org-1', 'm1'));
  });
});
