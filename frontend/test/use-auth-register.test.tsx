// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for useAuth.register — regression coverage for the signup bounce bug.
 *
 * `POST /auth/register` creates the user+org but does NOT issue tokens, so the
 * hook must authenticate immediately afterwards (delegating to `login`, which
 * establishes the session and routes to /dashboard) rather than dropping the
 * new user back on the login screen. The error path must NOT authenticate.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockPush = jest.fn();
jest.mock('next/router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../src/hooks/usePlugins', () => ({ clearPluginCache: jest.fn() }));

const mockApi = {
  isAuthenticated: jest.fn(() => true),
  isImpersonating: jest.fn(() => false),
  getProfile: jest.fn(async () => ({
    success: true,
    data: { user: { id: 'u1', username: 'neo', email: 'neo@example.com', role: 'owner', organizationId: 'o1' } },
  })),
  getUserOrganizations: jest.fn(async () => ({ data: { organizations: [] } })),
  setOrganizationId: jest.fn(),
  onSessionExpired: jest.fn(() => () => { /* unsubscribe */ }),
  register: jest.fn(async () => ({ success: true, data: { user: { id: 'u1' } } })),
  login: jest.fn(async () => ({ success: true })),
};
class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
}
jest.mock('@/lib/api', () => ({ __esModule: true, default: mockApi, ApiError }));

// Imported after the mocks are registered.
import { AuthProvider, useAuth } from '../src/hooks/useAuth';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('useAuth.register', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockApi.register.mockClear();
    mockApi.login.mockClear();
    mockApi.register.mockResolvedValue({ success: true, data: { user: { id: 'u1' } } });
  });

  it('establishes the session via login and routes to /dashboard after a successful register', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    mockPush.mockClear();

    await act(async () => {
      await result.current.register('neo', 'neo@example.com', 'password123', 'Neo Org');
    });

    expect(mockApi.register).toHaveBeenCalledWith('neo', 'neo@example.com', 'password123', 'Neo Org', undefined);
    // Session is established the same way the login path does — register
    // delegates to login with the same email/password.
    expect(mockApi.login).toHaveBeenCalledWith('neo@example.com', 'password123');
    // login() routes the newly-authenticated user to the dashboard.
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('surfaces the register error and does NOT authenticate when register fails', async () => {
    mockApi.register.mockResolvedValueOnce({ success: false, message: 'Email already registered' });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    mockPush.mockClear();
    mockApi.login.mockClear();

    await expect(
      act(async () => {
        await result.current.register('neo', 'neo@example.com', 'password123');
      }),
    ).rejects.toThrow('Email already registered');

    expect(mockApi.login).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalledWith('/dashboard');
  });
});
