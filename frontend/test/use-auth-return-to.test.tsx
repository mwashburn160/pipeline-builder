// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Return-to after sign-in, through `useAuth`: a session expiry remembers the
 * page the user was on, and every sign-in completion (password, MFA, passkey)
 * lands there instead of the dashboard. A deliberate sign-out returns nowhere.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockPush = jest.fn<AnyFn>(async () => true);
const mockRouter = { push: mockPush, asPath: '/dashboard/executions?status=failed' };
jest.mock('next/router', () => ({ useRouter: () => mockRouter }));
jest.mock('../src/hooks/usePlugins', () => ({ clearPluginCache: jest.fn<AnyFn>() }));
jest.mock('@/lib/passkeys', () => ({ signInWithPasskey: jest.fn<AnyFn>(async () => undefined) }));

let expire: (() => void) | null = null;
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
  onSessionExpired: jest.fn<AnyFn>((cb: () => void) => { expire = cb; return () => { expire = null; }; }),
  login: jest.fn<AnyFn>(async () => ({ success: true, data: {} })),
  verifyMfaLogin: jest.fn<AnyFn>(async () => ({ success: true })),
  logout: jest.fn<AnyFn>(async () => undefined),
};
class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, ApiError }));

import { AuthProvider, useAuth } from '../src/hooks/useAuth';
import { POST_SIGN_IN_KEY, forgetReturnPath } from '../src/lib/return-to';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

async function mounted() {
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.isInitialized).toBe(true));
  mockPush.mockClear();
  return result;
}

beforeEach(() => {
  window.sessionStorage.clear();
  forgetReturnPath();
  mockPush.mockClear();
  mockRouter.asPath = '/dashboard/executions?status=failed';
});

describe('useAuth return-to', () => {
  it('remembers the current page when the session expires', async () => {
    await mounted();
    act(() => { expire?.(); });
    expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBe('/dashboard/executions?status=failed');
    expect(mockPush).toHaveBeenCalledWith('/?expired=1');
  });

  it.each([
    ['password', (r: ReturnType<typeof useAuth>) => r.login('ada@example.com', 'pw')],
    ['mfa', (r: ReturnType<typeof useAuth>) => r.completeMfaLogin('chal', '123456')],
    ['passkey', (r: ReturnType<typeof useAuth>) => r.loginWithPasskey()],
  ])('%s sign-in lands on the remembered page', async (_label, signIn) => {
    const result = await mounted();
    window.sessionStorage.setItem(POST_SIGN_IN_KEY, '/dashboard/plugins?category=security');
    await act(async () => { await signIn(result.current); });
    expect(mockPush).toHaveBeenLastCalledWith('/dashboard/plugins?category=security');
  });

  it('refuses a planted off-site return path and lands on the dashboard', async () => {
    const result = await mounted();
    window.sessionStorage.setItem(POST_SIGN_IN_KEY, '//evil.example/phish');
    await act(async () => { await result.current.login('ada@example.com', 'pw'); });
    expect(mockPush).toHaveBeenLastCalledWith('/dashboard');
  });

  it('a deliberate sign-out forgets any remembered page', async () => {
    const result = await mounted();
    window.sessionStorage.setItem(POST_SIGN_IN_KEY, '/dashboard/plugins');
    await act(async () => { await result.current.logout(); });
    await waitFor(() => expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBeNull());
    expect(mockPush).toHaveBeenCalledWith('/');
  });
});
