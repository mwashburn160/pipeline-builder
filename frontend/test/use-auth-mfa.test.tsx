// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useAuth.login` / `completeMfaLogin` — the sign-in half that a second factor
 * splits in two.
 *
 * The property being pinned is that a pending factor is NOT a half-signed-in
 * state: `login` returns `mfa_required` and touches nothing — no profile
 * refresh, no navigation — so a caller that ignores the result simply fails to
 * sign in rather than landing somewhere with no session. `completeMfaLogin` then
 * finishes exactly as a plain password sign-in does.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockPush = jest.fn<AnyFn>();
jest.mock('next/router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../src/hooks/usePlugins', () => ({ clearPluginCache: jest.fn<AnyFn>() }));

const mockApi = {
  isAuthenticated: jest.fn<AnyFn>(() => true),
  restoreSession: jest.fn<AnyFn>(async () => true),
  isImpersonating: jest.fn<AnyFn>(() => false),
  getProfile: jest.fn<AnyFn>(async () => ({
    success: true,
    data: { user: { id: 'u1', username: 'ada', email: 'ada@example.com', role: 'owner', organizationId: 'o1' } },
  })),
  getUserOrganizations: jest.fn<AnyFn>(async () => ({ data: { organizations: [] } })),
  setOrganizationId: jest.fn<AnyFn>(),
  onAccessTokenChange: () => () => undefined,
  onSessionExpired: jest.fn<AnyFn>(() => () => { /* unsubscribe */ }),
  login: jest.fn<AnyFn>(),
  verifyMfaLogin: jest.fn<AnyFn>(),
  completeRequiredPasswordChange: jest.fn<AnyFn>(),
};
class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, ApiError }));

import { AuthProvider, useAuth } from '../src/hooks/useAuth';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/** A mounted, initialized hook with the navigation history cleared. */
async function mounted() {
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.isInitialized).toBe(true));
  mockPush.mockClear();
  mockApi.getProfile.mockClear();
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.isAuthenticated.mockReturnValue(true);
  mockApi.restoreSession.mockResolvedValue(true);
  mockApi.isImpersonating.mockReturnValue(false);
  mockApi.getProfile.mockResolvedValue({
    success: true,
    data: { user: { id: 'u1', username: 'ada', email: 'ada@example.com', role: 'owner', organizationId: 'o1' } },
  });
  mockApi.getUserOrganizations.mockResolvedValue({ data: { organizations: [] } });
  mockApi.onSessionExpired.mockReturnValue(() => { /* unsubscribe */ });
});

describe('useAuth.login with a second factor', () => {
  it('reports the pending factor and does NOT navigate or refresh', async () => {
    mockApi.login.mockResolvedValue({
      success: true,
      data: { mfaRequired: true, challengeId: 'chal-1', expiresAt: 123, methods: ['totp', 'recovery'] },
    });
    const result = await mounted();

    let outcome;
    await act(async () => { outcome = await result.current.login('ada@example.com', 'hunter2'); });

    expect(outcome).toEqual({ status: 'mfa_required', challengeId: 'chal-1', expiresAt: 123 });
    // Nothing happened locally: there is no session to refresh and nowhere to go.
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockApi.getProfile).not.toHaveBeenCalled();
  });

  it('reports a completed sign-in as usual when there is no second factor', async () => {
    mockApi.login.mockResolvedValue({ success: true, data: { accessToken: 'a', expiresIn: 900 } });
    const result = await mounted();

    let outcome;
    await act(async () => { outcome = await result.current.login('ada@example.com', 'hunter2'); });

    expect(outcome).toEqual({ status: 'complete' });
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('still throws on a refused sign-in', async () => {
    mockApi.login.mockResolvedValue({ success: false, message: 'Invalid credentials' });
    const result = await mounted();

    await expect(act(async () => { await result.current.login('ada@example.com', 'nope'); }))
      .rejects.toThrow('Invalid credentials');
  });
});

describe('useAuth.completeMfaLogin', () => {
  it('finishes the sign-in exactly as the password path would', async () => {
    mockApi.verifyMfaLogin.mockResolvedValue({ success: true, data: { accessToken: 'a', expiresIn: 900 } });
    const result = await mounted();

    await act(async () => { await result.current.completeMfaLogin('chal-1', '123456'); });

    expect(mockApi.verifyMfaLogin).toHaveBeenCalledWith({ challengeId: 'chal-1', code: '123456' });
    expect(mockApi.getProfile).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('honours redirect:false for callers that drive navigation themselves', async () => {
    mockApi.verifyMfaLogin.mockResolvedValue({ success: true, data: { accessToken: 'a', expiresIn: 900 } });
    const result = await mounted();

    await act(async () => { await result.current.completeMfaLogin('chal-1', '123456', { redirect: false }); });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('throws — and opens nothing — on a refused code', async () => {
    mockApi.verifyMfaLogin.mockResolvedValue({ success: false, message: 'Invalid credentials' });
    const result = await mounted();

    await expect(act(async () => { await result.current.completeMfaLogin('chal-1', '000000'); }))
      .rejects.toThrow('Invalid credentials');
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('a password below the org password policy', () => {
  const CHANGE = { passwordChangeRequired: true, challengeId: 'pw-1', expiresAt: 5, minLength: 14 };

  it('login reports the owed change and opens nothing', async () => {
    mockApi.login.mockResolvedValue({ success: true, data: CHANGE });
    const result = await mounted();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.login('ada@example.com', 'short'); });
    expect(outcome).toEqual({ status: 'password_change_required', challengeId: 'pw-1', expiresAt: 5, minLength: 14 });
    expect(mockApi.getProfile).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('completeMfaLogin reports it too, after the second factor', async () => {
    mockApi.verifyMfaLogin.mockResolvedValue({ success: true, data: CHANGE });
    const result = await mounted();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.completeMfaLogin('chal-1', '123456'); });
    expect(outcome).toMatchObject({ status: 'password_change_required', challengeId: 'pw-1' });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('completeRequiredPasswordChange opens the session and routes on', async () => {
    mockApi.completeRequiredPasswordChange.mockResolvedValue({ success: true, data: { accessToken: 'a', expiresIn: 900 } });
    const result = await mounted();
    let outcome: unknown;
    await act(async () => { outcome = await result.current.completeRequiredPasswordChange('pw-1', 'LongEnoughPassw0rd'); });
    expect(mockApi.completeRequiredPasswordChange).toHaveBeenCalledWith({ challengeId: 'pw-1', newPassword: 'LongEnoughPassw0rd' });
    expect(outcome).toEqual({ status: 'complete' });
    expect(mockApi.getProfile).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('completeRequiredPasswordChange throws on a refused password', async () => {
    mockApi.completeRequiredPasswordChange.mockResolvedValue({ success: false, message: 'This password has appeared in a known data breach.' });
    const result = await mounted();
    await expect(act(async () => { await result.current.completeRequiredPasswordChange('pw-1', 'Passw0rd12345'); }))
      .rejects.toThrow('known data breach');
    expect(mockPush).not.toHaveBeenCalled();
  });
});
