// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Members → Teams: everything a parent admin does to a team from the parent —
 * open it, manage its settings in place, export it, delete it (confirm, then
 * step-up), and restore a recently deleted one — plus the Create Team gate.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import type { UserOrgMembership } from '@/types';
import MembersPage from '../pages/dashboard/members';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = { query: {}, pathname: '/dashboard/members', asPath: '/dashboard/members', isReady: true, replace: jest.fn(), push: jest.fn() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const refreshUser = jest.fn().mockResolvedValue(undefined);
const switchOrganization = jest.fn();
let mockOrganizations: UserOrgMembership[] = [];
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: { organizationId: 'org-1' }, organizations: mockOrganizations, refreshUser, switchOrganization }),
}));

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, onConfirmed }: { action: string; onConfirmed: (t: string) => void }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Verify</button>
    </div>
  ),
}));
jest.mock('@/components/teams/TeamSettingsDrawer', () => ({
  __esModule: true,
  TeamSettingsDrawer: ({ team }: { team: { orgId: string } }) => <div data-testid="team-drawer">{team.orgId}</div>,
}));
const triggerBlobDownload = jest.fn();
jest.mock('@/lib/csv-export', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

/** Every api method resolves to an empty success unless a test overrides it. */
const mockApi: Record<string, jest.Mock> = {};
jest.mock('@/lib/api', () => {
  const api = new Proxy({}, {
    get: (_t, key: string) => mockApi[key] ?? (() => Promise.resolve({ success: true, data: {} })),
  });
  return { __esModule: true, default: api, api, ApiError: class extends Error {} };
});

const root = (over: Partial<UserOrgMembership> = {}): UserOrgMembership => ({
  id: 'org-1', name: 'Acme', role: 'owner', tier: 'team', childOrgCount: 2, ...over,
});

const ADMIN_PERMS = ['members:manage', 'org:settings', 'org:impersonation', 'org:idp'];

function asAdmin(perms: string[] = ADMIN_PERMS) {
  mockAuthGuard({
    isAdmin: true,
    user: { id: 'me', organizationId: 'org-1', permissions: perms },
    can: (p: string) => perms.includes(p),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockApi)) delete mockApi[k];
  mockOrganizations = [root()];
  asAdmin();
  mockApi.getOrganizationTeams = jest.fn().mockResolvedValue({
    success: true, data: { teams: [{ orgId: 't1', orgName: 'Platform' }, { orgId: 't2', orgName: 'Data' }] },
  });
  mockApi.listDeletedTeams = jest.fn().mockResolvedValue({ success: true, data: { teams: [] } });
});

describe('Create Team gate', () => {
  it('shows Create Team to an org:settings holder', async () => {
    render(<MembersPage />);
    expect(await screen.findByRole('button', { name: /create team/i })).toBeEnabled();
  });

  it('hides it from a members:manage-only admin — the route needs org:settings', async () => {
    asAdmin(['members:manage']);
    render(<MembersPage />);
    await screen.findByRole('button', { name: 'Open Platform' });
    expect(screen.queryByRole('button', { name: /create team/i })).not.toBeInTheDocument();
  });

  it('keeps the tier-ineligible disabled state and its tooltip', async () => {
    mockOrganizations = [root({ tier: 'pro', childOrgCount: 0 })];
    render(<MembersPage />);
    const btn = await screen.findByRole('button', { name: /create team/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(/Team or Enterprise plan/));
  });
});

describe('Teams row actions', () => {
  it('Open switches into the team', async () => {
    switchOrganization.mockResolvedValue(undefined);
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Platform' }));
    await waitFor(() => expect(switchOrganization).toHaveBeenCalledWith('t1'));
    expect(pageToast.success).toHaveBeenCalledWith('Switched to Platform');
  });

  it('Open failure is a toast naming the team, never silent', async () => {
    switchOrganization.mockRejectedValue(new Error('Forbidden'));
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Platform' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith(expect.stringMatching(/Couldn't open Platform: Forbidden/)));
  });

  it('Manage opens the settings drawer for THAT team', async () => {
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Data' }));
    expect(screen.getByTestId('team-drawer')).toHaveTextContent('t2');
  });

  it('Export downloads the team\'s JSON', async () => {
    mockApi.exportOrganization = jest.fn().mockResolvedValue('{"org":1}');
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Platform' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /export data/i }));
    await waitFor(() => expect(mockApi.exportOrganization).toHaveBeenCalledWith('t1'));
    expect(triggerBlobDownload).toHaveBeenCalledWith(expect.any(Blob), 'team-Platform-export.json');
  });

  it('Delete confirms the retention window, steps up, deletes, then refreshes the session', async () => {
    mockApi.deleteTeam = jest.fn().mockResolvedValue({ success: true });
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Platform' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete team/i }));

    const confirm = await screen.findByRole('dialog', { name: /delete team platform/i });
    expect(confirm).toHaveTextContent(/restorable from Recently deleted teams until its retention window ends/i);
    expect(mockApi.deleteTeam).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete team' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(mockApi.deleteTeam).toHaveBeenCalledWith('org-1', 't1', 'step-up-token'));
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });

  it('member-only admins get no lifecycle menu', async () => {
    asAdmin(['members:manage']);
    render(<MembersPage />);
    await screen.findByRole('button', { name: 'Open Platform' });
    expect(screen.queryByRole('button', { name: 'More actions for Platform' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Platform' })).not.toBeInTheDocument();
    expect(mockApi.listDeletedTeams).not.toHaveBeenCalled();
  });
});

describe('Recently deleted teams', () => {
  const deleted = { orgId: 't9', orgName: 'Legacy', deletedAt: '2026-09-10T00:00:00.000Z', purgeAfter: '2026-10-10T00:00:00.000Z' };

  it('shows even when no live team remains, with the purge date, and restores after step-up', async () => {
    mockOrganizations = [root({ childOrgCount: 0 })];
    mockApi.listDeletedTeams = jest.fn().mockResolvedValue({ success: true, data: { teams: [deleted] } });
    mockApi.restoreOrganization = jest.fn().mockResolvedValue({ success: true });
    render(<MembersPage />);

    expect(await screen.findByText('Recently deleted teams')).toBeInTheDocument();
    expect(mockApi.listDeletedTeams).toHaveBeenCalledWith('org-1', expect.anything());
    expect(screen.getByText(/purged permanently on/i)).toHaveTextContent('2026');
    expect(mockApi.getOrganizationTeams).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Legacy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(mockApi.restoreOrganization).toHaveBeenCalledWith('t9', 'step-up-token'));
    await waitFor(() => expect(refreshUser).toHaveBeenCalled());
  });
});
