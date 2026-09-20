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

// Renders `title` + `details` too: a destructive step-up action is ONE dialog
// that states what is lost and takes the factor, so the cost copy has to be
// asserted HERE — there is no confirm dialog in front of it to carry it.
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

  it('keeps the tier-ineligible disabled state, with the reason VISIBLE', async () => {
    // The reason used to live only in `title=`: invisible on touch, unread by
    // screen readers, and with no way to act on it. It is now text next to the
    // control, tied to it by aria-describedby, and it links to Billing.
    mockOrganizations = [root({ tier: 'pro', childOrgCount: 0 })];
    render(<MembersPage />);
    const btn = await screen.findByRole('button', { name: /create team/i });
    expect(btn).toBeDisabled();
    const reasonId = btn.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId!);
    expect(reason).toHaveTextContent(/Teams need a Team or Enterprise plan/i);
    expect(within(reason!).getByRole('link', { name: /upgrade this organization/i }))
      .toHaveAttribute('href', '/dashboard/billing');
  });

  it('tells a viewer who cannot open Billing to ask an owner, with no dead link', async () => {
    // `billing:manage` + org admin is what the upgrade link needs; without it
    // the link would land on AccessDenied, so the copy names who can act.
    mockOrganizations = [root({ tier: 'pro', childOrgCount: 0 })];
    mockAuthGuard({
      isAdmin: false,
      user: { id: 'me', organizationId: 'org-1', permissions: ['members:manage', 'org:settings'] },
      can: (p: string) => ['members:manage', 'org:settings'].includes(p),
    });
    render(<MembersPage />);
    const btn = await screen.findByRole('button', { name: /create team/i });
    const reason = document.getElementById(btn.getAttribute('aria-describedby')!);
    expect(reason).toHaveTextContent(/Ask an owner to upgrade this organization/i);
    expect(within(reason!).queryByRole('link')).not.toBeInTheDocument();
  });

  it('stays visible for a root org with no teams at all — that org needs it most', async () => {
    mockOrganizations = [root({ childOrgCount: 0 })];
    mockApi.getOrganizationTeams = jest.fn().mockResolvedValue({ success: true, data: { teams: [] } });
    render(<MembersPage />);
    expect(await screen.findByRole('button', { name: /create team/i })).toBeEnabled();
  });
});

describe('TeamsCard empty state', () => {
  it('offers the create control its copy promises', async () => {
    // Reached when every live team is deleted but still restorable: the card
    // renders, and its "create a new one" sentence used to point at nothing.
    mockOrganizations = [root({ childOrgCount: 0 })];
    mockApi.getOrganizationTeams = jest.fn().mockResolvedValue({ success: true, data: { teams: [] } });
    mockApi.listDeletedTeams = jest.fn().mockResolvedValue({
      success: true, data: { teams: [{ orgId: 't9', orgName: 'Gone', deletedAt: '2026-09-01T00:00:00Z', purgeAfter: '2026-10-01T00:00:00Z' }] },
    });
    render(<MembersPage />);
    expect(await screen.findByText(/No live teams\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^create a team$/i })).toBeEnabled();
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

  it('Delete opens ONE dialog that states the retention window and takes the factor', async () => {
    mockApi.deleteTeam = jest.fn().mockResolvedValue({ success: true });
    render(<MembersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Platform' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete team/i }));

    // The house rule (see StepUpModal's doc comment and the "Delete your
    // account" flow on Settings): a destructive step-up action does NOT confirm
    // and then re-prompt. This used to show a ConfirmDialog whose Confirm opened
    // a second, separate step-up dialog.
    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    const confirm = screen.getByRole('dialog', { name: /delete team platform\?/i });
    expect(confirm).toHaveTextContent(/restorable from Recently deleted teams until its retention window ends/i);
    expect(mockApi.deleteTeam).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Verify' }));
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
