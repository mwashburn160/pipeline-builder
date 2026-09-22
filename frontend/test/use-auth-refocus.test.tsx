// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useAuth re-fetches the profile on every tab refocus. When nothing changed it
 * must hand consumers the SAME user object and context value — otherwise every
 * effect keyed on the user re-runs: forms reset under the user's cursor and
 * pages reload. Also covers the per-session cache clearing on logout/expiry.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useEffect, useState } from 'react';
import { render, screen, act, waitFor, fireEvent, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockRouter = { push: jest.fn<AnyFn>(), replace: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));
const mockClearQueryCache = jest.fn<AnyFn>();
jest.mock('@/lib/query-cache', () => {
  const actual = jest.requireActual<typeof import('../src/lib/query-cache')>('../src/lib/query-cache');
  return { ...actual, clearQueryCache: () => { mockClearQueryCache(); actual.clearQueryCache(); } };
});
const mockClearAttachmentImageCache = jest.fn<AnyFn>();
jest.mock('@/lib/attachment-image-cache', () => ({ clearAttachmentImageCache: () => mockClearAttachmentImageCache() }));

const profile = () => ({
  success: true,
  data: { user: { id: 'u1', username: 'neo', email: 'neo@example.com', role: 'owner', organizationId: 'o1', features: ['a', 'b'] } },
});
let sessionExpired: (() => void) | null = null;
const mockApi = {
  isAuthenticated: jest.fn<AnyFn>(() => true),
  // A page load has no access token in memory; the provider trades the
  // HttpOnly refresh cookie for one before deciding "signed out".
  restoreSession: jest.fn<AnyFn>(async () => true),
  isImpersonating: jest.fn<AnyFn>(() => false),
  getProfile: jest.fn<AnyFn>(async () => profile()),
  getUserOrganizations: jest.fn<AnyFn>(async () => ({ data: { organizations: [{ organizationId: 'o1', organizationName: 'Org', role: 'owner' }] } })),
  setOrganizationId: jest.fn<AnyFn>(),
  onAccessTokenChange: () => () => undefined,
  onSessionExpired: jest.fn<AnyFn>((cb: () => void) => { sessionExpired = cb; return () => { sessionExpired = null; }; }),
  logout: jest.fn<AnyFn>(async () => undefined),
};
class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, ApiError }));

import { AuthProvider, useAuth } from '../src/hooks/useAuth';

async function refocus() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => expect(mockApi.getUserOrganizations).toHaveBeenCalledTimes(2));
}

/** A settings-style form seeded from the user in an effect keyed on the user object. */
function ProfileForm({ onUser }: { onUser: (u: unknown) => void }) {
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  useEffect(() => {
    onUser(user);
    if (user) setUsername(user.username);
  }, [user, onUser]);
  return <input aria-label="username" value={username} onChange={(e) => setUsername(e.target.value)} />;
}

describe('useAuth refocus with an unchanged profile', () => {
  beforeEach(() => {
    mockApi.getProfile.mockImplementation(async () => profile());
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  it('keeps the user object and context value identity', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;
    const { result, rerender } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe('u1'));
    const before = result.current;

    // A provider re-render with nothing changed keeps the context value.
    rerender();
    expect(result.current).toBe(before);

    await refocus();

    expect(mockApi.getProfile).toHaveBeenCalledTimes(2);
    expect(result.current.user).toBe(before.user);
    expect(result.current.organizations).toBe(before.organizations);
    expect(result.current).toBe(before);
  });

  it('does not reset a form the user is typing in', async () => {
    const onUser = jest.fn<AnyFn>();
    render(<AuthProvider><ProfileForm onUser={onUser} /></AuthProvider>);
    const input = screen.getByLabelText('username') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('neo'));

    fireEvent.change(input, { target: { value: 'neo-the-one' } });
    await refocus();

    expect(input.value).toBe('neo-the-one');
    expect(onUser.mock.calls.filter(([u]) => u).length).toBe(1);
  });

  it('still publishes a changed profile', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe('u1'));
    const before = result.current.user;

    mockApi.getProfile.mockImplementation(async () => {
      const p = profile();
      p.data.user.username = 'trinity';
      return p;
    });
    await refocus();

    expect(result.current.user).not.toBe(before);
    expect(result.current.user?.username).toBe('trinity');
  });
});

describe('useAuth per-session cache clearing', () => {
  it('clears the shared read cache (plugins included) and attachment-image cache on logout', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    await act(async () => { await result.current.logout(); });

    expect(mockClearQueryCache).toHaveBeenCalled();
    expect(mockClearAttachmentImageCache).toHaveBeenCalled();
  });

  it('clears the attachment-image cache when the session expires', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => { sessionExpired?.(); });

    expect(mockClearAttachmentImageCache).toHaveBeenCalledTimes(1);
  });
});
