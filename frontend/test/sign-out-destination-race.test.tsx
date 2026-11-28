// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A sign-out that says WHY (`/?reason=idle&minutes=N`, `/?reason=session-expired`)
 * must land there, though two navigations race for the tab: `logout()` (or the
 * session-expired handler) pushes the sign-in page with the reason, and the
 * guarded page's `useAuthGuard` sees `user` clear and bounces to sign-in too.
 * Next.js lets the LATER navigation win, and the guard's ran later — so the
 * reason was lost to a bare `/`. The sign-out now records where it is going,
 * the guard routes there instead, and the record is spent once used.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, act, waitFor, cleanup } from '@testing-library/react';

/** Every navigation the app asked for, in order; the last one is where the tab ends up. */
const navigations: string[] = [];
const mockRouter = {
  pathname: '/dashboard/pipelines',
  asPath: '/dashboard/pipelines',
  query: {},
  isReady: true,
  push: jest.fn<AnyFn>(async (url: string) => { navigations.push(url); return true; }),
  replace: jest.fn<AnyFn>(async (url: string) => { navigations.push(url); return true; }),
};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));
jest.mock('@/lib/passkeys', () => ({ signInWithPasskey: jest.fn<AnyFn>(async () => undefined) }));

let expire: ((reason?: string, detail?: { idleTimeoutMinutes?: number }) => void) | null = null;
const mockApi = {
  isAuthenticated: jest.fn<AnyFn>(() => true),
  restoreSession: jest.fn<AnyFn>(async () => true),
  isImpersonating: jest.fn<AnyFn>(() => false),
  getProfile: jest.fn<AnyFn>(async () => ({
    success: true,
    data: { user: { id: 'u1', username: 'ada', email: 'ada@example.com', role: 'owner', organizationId: 'o1' } },
  })),
  getUserOrganizations: jest.fn<AnyFn>(async () => ({ data: { organizations: [] } })),
  getBillingConfig: jest.fn<AnyFn>(async () => ({ data: { enabled: false } })),
  setOrganizationId: jest.fn<AnyFn>(),
  onAccessTokenChange: () => () => undefined,
  onOrganizationChange: () => () => undefined,
  onIdentityChange: () => () => undefined,
  onSessionExpired: jest.fn<AnyFn>((cb: (reason?: string, detail?: { idleTimeoutMinutes?: number }) => void) => { expire = cb; return () => { expire = null; }; }),
  logout: jest.fn<AnyFn>(async () => undefined),
};
class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, api: mockApi, ApiError }));

jest.mock('@/components/landing/LandingPage', () => ({ __esModule: true, default: () => null }));
jest.mock('next/head', () => require('./helpers/pageMocks').headModule());

import { AuthProvider, useAuth } from '../src/hooks/useAuth';
import Home from '../pages/index';
import { useAuthGuard } from '../src/hooks/useAuthGuard';

let auth: ReturnType<typeof useAuth> | null = null;
/** A panel that guards itself too — a dashboard page holds many such callers. */
function GuardedPanel() {
  useAuthGuard();
  return null;
}
function GuardedPage() {
  useAuthGuard();
  auth = useAuth();
  return <><GuardedPanel /><GuardedPanel /></>;
}

async function signedInOnGuardedPage() {
  render(<AuthProvider><GuardedPage /></AuthProvider>);
  await waitFor(() => expect(auth?.isAuthenticated).toBe(true));
  navigations.length = 0;
}

beforeEach(() => {
  window.sessionStorage.clear();
  navigations.length = 0;
  auth = null;
});

describe('a sign-out with a reason survives the auth guard\'s bounce', () => {
  it('an idle sign-out from a guarded page ends on /?reason=idle&minutes=N', async () => {
    await signedInOnGuardedPage();

    await act(async () => { await auth!.logout({ reason: 'idle', idleTimeoutMinutes: 15 }); });

    await waitFor(() => expect(navigations.length).toBeGreaterThan(0));
    // The guard bounced too, but to the same place — never a bare '/'.
    expect(navigations).not.toContain('/');
    expect(navigations.at(-1)).toBe('/?reason=idle&minutes=15');
  });

  it('a session that ran out (here or in another tab) ends on its reason too', async () => {
    await signedInOnGuardedPage();

    act(() => { expire?.('idle', { idleTimeoutMinutes: 30 }); });

    await waitFor(() => expect(navigations.length).toBeGreaterThan(0));
    expect(navigations).not.toContain('/');
    expect(navigations.at(-1)).toBe('/?reason=idle&minutes=30');
  });

  it('is spent once the sign-in page is reached: a later signed-out bounce goes to plain sign-in', async () => {
    await signedInOnGuardedPage();
    await act(async () => { await auth!.logout({ reason: 'idle', idleTimeoutMinutes: 15 }); });
    await waitFor(() => expect(navigations.at(-1)).toBe('/?reason=idle&minutes=15'));
    cleanup();

    // The sign-out's destination renders (the real landing page).
    render(<AuthProvider><Home /></AuthProvider>);
    cleanup();

    // A later visit to a guarded page, signed out, in the same tab.
    navigations.length = 0;
    mockApi.isAuthenticated.mockReturnValue(false);
    mockApi.restoreSession.mockResolvedValue(false);
    render(<AuthProvider><GuardedPage /></AuthProvider>);
    await waitFor(() => expect(navigations).toContain('/'));
    expect(navigations).not.toContain('/?reason=idle&minutes=15');
    mockApi.isAuthenticated.mockReturnValue(true);
    mockApi.restoreSession.mockResolvedValue(true);
  });

  it('a deliberate sign-out still goes to plain sign-in', async () => {
    await signedInOnGuardedPage();

    await act(async () => { await auth!.logout(); });

    await waitFor(() => expect(navigations.length).toBeGreaterThan(0));
    expect(navigations.at(-1)).toBe('/');
  });
});

describe('the pending sign-out record', () => {
  it('survives a reload through sessionStorage, refuses anything but the sign-in page, and clears', async () => {
    const mod = await import('../src/lib/pending-sign-out');
    mod.setPendingSignOut('/?reason=idle&minutes=15');
    jest.resetModules();
    // A fresh module instance: memory is gone, as after a reload.
    const reloaded = await import('../src/lib/pending-sign-out');
    expect(reloaded.pendingSignOut()).toBe('/?reason=idle&minutes=15');
    // Read, not spent: every guard on the page gets the same answer.
    expect(reloaded.pendingSignOut()).toBe('/?reason=idle&minutes=15');
    reloaded.clearPendingSignOut();
    expect(reloaded.pendingSignOut()).toBeNull();

    window.sessionStorage.setItem('pb.pendingSignOut', '//evil.example/?reason=idle');
    expect(reloaded.pendingSignOut()).toBeNull();
  });
});
