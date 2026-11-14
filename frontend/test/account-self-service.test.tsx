// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The account's own self-service on Settings → Profile, and the sign-in link:
 * - Delete account reads `GET /user/account/deletion` FIRST, so the one
 *   step-up dialog says which case applies — owned orgs deleted with the
 *   account (no other members), or the orgs that block it (confirm disabled);
 * - "Download my data" (`GET /user/export`, step-up) saves the JSON;
 * - the sign-in card links to "Forgot password?".
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { StepUpRequiredError } from '../src/lib/api/errors';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: {}, pathname: '/dashboard/settings' })));

// The dialog as a plain stand-in: what it SAYS (title + details), whether it
// lets the person confirm (confirmDisabledReason), and a Verify that hands the
// caller a token.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ title, details, onConfirmed, confirmDisabledReason, onClose }: {
    title?: string; details?: ReactNode; onConfirmed: (t: string) => Promise<void> | void;
    confirmDisabledReason?: string | null; onClose: () => void;
  }) => (
    <div role="dialog" aria-label={title ?? 'step-up'}>
      {details}
      {confirmDisabledReason && <p data-testid="confirm-blocked">{confirmDisabledReason}</p>}
      <button type="button" disabled={!!confirmDisabledReason} onClick={async () => { await onConfirmed('tok'); onClose(); }}>Verify</button>
    </div>
  ),
}));

const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

const getAccountDeletionPlan = jest.fn<AnyFn>();
const deleteAccount = jest.fn<AnyFn>();
const exportOwnData = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    getAccountDeletionPlan: (...a: unknown[]) => getAccountDeletionPlan(...a),
    deleteAccount: (...a: unknown[]) => deleteAccount(...a),
    exportOwnData: (...a: unknown[]) => exportOwnData(...a),
  },
}));

import SettingsPage from '../pages/dashboard/settings';
import { blockerText, deletionBlockedReason } from '../src/components/settings/AccountDeletionDetails';
import { personalExportFilename } from '../src/components/settings/PersonalDataExport';
import { PasswordStep } from '../src/components/auth/SignInCard/PasswordStep';
import type { SignInFlow } from '../src/components/auth/SignInCard/useSignInFlow';

const PLAN_OK = { canDelete: true, orgsDeleted: [], blockedBy: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', username: 'jane', email: 'jane@acme.com', isEmailVerified: true, permissions: [] } });
  getAccountDeletionPlan.mockResolvedValue({ success: true, data: PLAN_OK });
  deleteAccount.mockResolvedValue({ success: true, data: { orgsDeleted: [] } });
  exportOwnData.mockResolvedValue('{"account":{}}');
});

const openDelete = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^delete account$/i }));
  return screen.findByRole('dialog', { name: /delete your account/i });
};

describe('Delete account — the plan is read before the step-up', () => {
  it('names the sole-member orgs that are deleted with the account', async () => {
    getAccountDeletionPlan.mockResolvedValue({ success: true, data: { canDelete: true, orgsDeleted: [{ orgId: 'o1', name: 'Jane Personal' }], blockedBy: [] } });
    render(<SettingsPage />);
    await openDelete();
    expect(screen.getByTestId('orgs-deleted')).toHaveTextContent(/This organization has no other members/i);
    expect(screen.getByTestId('orgs-deleted')).toHaveTextContent('Jane Personal');
    expect(screen.getByText(/recoverable by support for 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
  });

  it('plural copy for several orgs', async () => {
    getAccountDeletionPlan.mockResolvedValue({ success: true, data: { canDelete: true, orgsDeleted: [{ orgId: 'o1', name: 'A' }, { orgId: 'o2', name: '' }], blockedBy: [] } });
    render(<SettingsPage />);
    await openDelete();
    expect(screen.getByTestId('orgs-deleted')).toHaveTextContent(/These organizations have no other members and are deleted/i);
    // A nameless org still gets a label.
    expect(screen.getByTestId('orgs-deleted')).toHaveTextContent('o2');
  });

  it('lists every blocking org and disables the confirm', async () => {
    getAccountDeletionPlan.mockResolvedValue({ success: true, data: {
      canDelete: false,
      orgsDeleted: [],
      blockedBy: [
        { orgId: 'o1', name: 'Acme', reason: 'other-members', otherMembers: 3 },
        { orgId: 'o2', name: 'Beta', reason: 'has-teams', otherMembers: 0 },
      ],
    } });
    render(<SettingsPage />);
    await openDelete();
    const blocking = screen.getByTestId('orgs-blocking');
    expect(blocking).toHaveTextContent(/Acme has 3 other members — transfer ownership first/);
    expect(blocking).toHaveTextContent(/Beta has teams — delete or move them first/);
    expect(screen.getByTestId('confirm-blocked')).toHaveTextContent(/handed on first/i);
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });

  it('deletes with the step-up token and leaves the app', async () => {
    render(<SettingsPage />);
    await openDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('tok'));
  });

  it('a 502 (snapshot failed, nothing deleted) is shown on the Delete card', async () => {
    deleteAccount.mockRejectedValue(new Error('Could not snapshot Jane Personal for recovery — nothing was deleted'));
    render(<SettingsPage />);
    await openDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/nothing was deleted/i)).toBeInTheDocument();
  });

  it('a failed plan read opens no dialog and says why', async () => {
    getAccountDeletionPlan.mockRejectedValue(new Error('Service unavailable'));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete account$/i }));
    expect(await screen.findByText(/Service unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /delete your account/i })).not.toBeInTheDocument();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('an empty plan response is treated as a failed read', async () => {
    getAccountDeletionPlan.mockResolvedValue({ success: true });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^delete account$/i }));
    expect(await screen.findByText(/Could not check what deleting your account would do/i)).toBeInTheDocument();
  });
});

describe('deletion copy helpers', () => {
  it('blockerText covers every reason, singular and plural', () => {
    expect(blockerText({ orgId: 'o', name: 'A', reason: 'other-members', otherMembers: 1 })).toMatch(/1 other member —/);
    expect(blockerText({ orgId: 'o', name: 'A', reason: 'system-org', otherMembers: 0 })).toMatch(/system organization/);
  });
  it('deletionBlockedReason names a single blocker inline', () => {
    expect(deletionBlockedReason(PLAN_OK)).toBeNull();
    expect(deletionBlockedReason({ canDelete: false, orgsDeleted: [], blockedBy: [{ orgId: 'o', name: 'Acme', reason: 'has-teams', otherMembers: 0 }] }))
      .toBe('Your organization Acme has teams — delete or move them first.');
  });
});

describe('Download my data', () => {
  const download = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /download my data/i }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /download your data/i })).getByRole('button', { name: 'Verify' }));
  };

  it('exports with the step-up token and saves the JSON', async () => {
    render(<SettingsPage />);
    await download();
    await waitFor(() => expect(exportOwnData).toHaveBeenCalledWith('tok'));
    expect(triggerBlobDownload).toHaveBeenCalledWith(expect.any(Blob), personalExportFilename());
    expect(await screen.findByText(/Your data was downloaded/i)).toBeInTheDocument();
  });

  it('a refused-again token saves the file when the global dialog\'s replay answers', async () => {
    const err = new StepUpRequiredError('Re-verify', 'STEP_UP_REQUIRED');
    err.attachResume(Promise.resolve('{"replayed":true}'));
    exportOwnData.mockRejectedValue(err);
    render(<SettingsPage />);
    await download();
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalled());
  });

  it('shows a failed export', async () => {
    exportOwnData.mockRejectedValue(new Error('Export failed'));
    render(<SettingsPage />);
    await download();
    expect(await screen.findByText(/Export failed/i)).toBeInTheDocument();
    expect(triggerBlobDownload).not.toHaveBeenCalled();
  });

  it('the file name carries the date', () => {
    expect(personalExportFilename(new Date('2026-11-13T10:00:00Z'))).toBe('pipeline-builder-account-2026-11-13.json');
  });
});

describe('sign-in "Forgot password?"', () => {
  const flow = (identifier: string) => ({
    ssoRequired: false, ssoOffered: false, ssoBusy: false, startSso: jest.fn(), handleSignIn: jest.fn(),
    identifier, changeIdentifier: jest.fn(), discoverSso: jest.fn(async () => undefined),
    isSubmitting: false, showPassword: false, setShowPassword: jest.fn(), password: '', setPassword: jest.fn(),
  }) as unknown as SignInFlow;

  it('carries a typed email to the request page', () => {
    render(<PasswordStep flow={flow('jane@acme.com')} />);
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute('href', '/auth/forgot-password?email=jane%40acme.com');
  });

  it('a username is not sent along (the request takes an address)', () => {
    render(<PasswordStep flow={flow('jane')} />);
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute('href', '/auth/forgot-password');
  });
});
