// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * /invite/accept — "Create account & accept" for a logged-out invitee.
 *
 * Registering with the invitation token now JOINS the inviting org server-side
 * (POST /auth/register accepts the invitation in the same transaction and
 * creates no org of its own). The page must then not accept a second time —
 * that call would answer "already accepted". Against an older backend, which
 * created an org and left the accept to the page, `register` reports
 * `invitationAccepted: false` and the page still accepts.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AcceptInvitePage from '../pages/invite/accept';

const mockPush = jest.fn<AnyFn>();
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({
  isReady: true, query: { token: 'tok-1' }, asPath: '/invite/accept?token=tok-1', push: mockPush,
})));

const mockRegister = jest.fn<AnyFn>();
const mockRefreshUser = jest.fn<AnyFn>().mockResolvedValue(undefined);
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({
  user: null, isInitialized: true, register: mockRegister, refreshUser: mockRefreshUser,
})));
jest.mock('framer-motion', () => require('./helpers/pageMocks').motionModule());

jest.mock('@/lib/api', () => {
  const api = { getInvitationByToken: jest.fn<AnyFn>(), acceptInvitation: jest.fn<AnyFn>(), getOAuthUrl: jest.fn<AnyFn>() };
  return { __esModule: true, default: api, api };
});
const mockApi = jest.requireMock<Record<string, unknown>>('@/lib/api').api as Record<'getInvitationByToken' | 'acceptInvitation', jest.Mock<AnyFn>>;

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getInvitationByToken.mockResolvedValue({
    success: true,
    data: {
      invitation: {
        email: 'new@example.com', role: 'member', status: 'pending', expiresAt: '2026-12-31T00:00:00Z',
        isValid: true, canAcceptViaEmail: true, canAcceptViaGoogle: false,
      },
    },
  });
  mockApi.acceptInvitation.mockResolvedValue({ success: true });
});

async function submitRegistration() {
  render(<AcceptInvitePage />);
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'newbie' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Passw0rdPassw0rd' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Passw0rdPassw0rd' } });
  fireEvent.click(screen.getByRole('button', { name: /create account/i }));
  await waitFor(() => expect(mockRegister).toHaveBeenCalled());
}

it('registers WITH the invitation token, and does not accept a second time once the backend has', async () => {
  mockRegister.mockResolvedValue({ invitationAccepted: true });

  await submitRegistration();

  expect(mockRegister).toHaveBeenCalledWith('newbie', 'new@example.com', 'Passw0rdPassw0rd', undefined, undefined, { redirect: false, invitationToken: 'tok-1' });
  await waitFor(() => expect(mockRefreshUser).toHaveBeenCalled());
  expect(mockApi.acceptInvitation).not.toHaveBeenCalled();
});

it('still accepts when an older backend left that to the page', async () => {
  mockRegister.mockResolvedValue({ invitationAccepted: false });

  await submitRegistration();

  await waitFor(() => expect(mockApi.acceptInvitation).toHaveBeenCalledWith('tok-1'));
});
