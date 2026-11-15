// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Profile: CHANGING the sign-in email is step-up gated server-side
 * (it is where a password reset is sent), so the save opens StepUpModal and
 * replays its token — the same flow as change-password. A username-only save
 * sends no token and opens no dialog.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/settings/PersonalDataExport', () => ({ PersonalDataExport: () => null }));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, title }: { onConfirmed: (t: string) => void; title?: string }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>{`Confirm: ${title ?? ''}`}</button>
  ),
}));

const updateProfile = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    updateProfile: (...a: unknown[]) => updateProfile(...a),
  },
}));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({
  isReady: true, query: {}, pathname: '/dashboard/settings', replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>(),
})));

import SettingsPage from '../pages/dashboard/settings';

beforeEach(() => {
  jest.clearAllMocks();
  updateProfile.mockResolvedValue({ success: true, data: { user: {} } });
  mockAuthGuard({
    user: { id: 'u1', organizationId: 'org-1', username: 'alice', email: 'alice@acme.com', isEmailVerified: true, permissions: [] },
    can: () => false,
  });
});

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('Settings → Profile: email change', () => {
  it('asks for a step-up before changing the email, and sends its token', async () => {
    render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'new@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const confirm = await screen.findByRole('button', { name: /Confirm: Change your sign-in email/ });
    expect(updateProfile).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ email: 'new@acme.com' }, 'step-up-token'));
  });

  it('saves a username-only edit straight away, with no step-up', async () => {
    render(<SettingsPage />);
    await screen.findByLabelText('Username');
    fireEvent.change(field('Username'), { target: { value: 'alice2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ username: 'alice2' }, undefined));
    expect(screen.queryByRole('button', { name: /Confirm:/ })).not.toBeInTheDocument();
  });
});
