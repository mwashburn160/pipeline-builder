// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useAuthGuard()` with NO options enforces every page's declared gate.
 *
 * The convention (see the hook's module comment) is that a page states its read
 * gate once — in its nav entry or in `page-access.ts` — and calls the guard bare.
 * That only holds if the bare guard really derives the gate for EVERY declared
 * route, so this drives the real hook once per route: a viewer holding nothing
 * is refused for exactly the requirement declared, a viewer holding exactly that
 * requirement gets in, and an open route never refuses anyone.
 */

import { renderHook } from '@testing-library/react';
import type { User } from '../src/types';
import { declaredPagePaths, resolvePageGate, isOpenGate } from '../src/lib/page-access';

let pathname = '/dashboard';
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ pathname, replace: jest.fn(), push: jest.fn() }),
}));

let user: Partial<User> | null = null;
jest.mock('../src/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({
    user,
    isAuthenticated: true,
    isInitialized: true,
    isLoading: false,
    isReadOnly: false,
    logout: jest.fn(),
    refreshUser: jest.fn(),
  }),
}));

import { useAuthGuard } from '../src/hooks/useAuthGuard';

function guardAt(path: string, viewer: Partial<User>) {
  pathname = path;
  user = viewer;
  return renderHook(() => useAuthGuard()).result.current;
}

const MEMBER: Partial<User> = { id: 'u1', role: 'member', permissions: [] };
const ROUTES = declaredPagePaths();

describe('useAuthGuard() derives each declared page gate', () => {
  it('covers the whole declared table', () => {
    expect(ROUTES.length).toBeGreaterThan(40);
  });

  it.each(ROUTES)('%s', (route) => {
    const gate = resolvePageGate(route);
    const bare = guardAt(route, MEMBER);

    if (isOpenGate(gate)) {
      expect(bare.accessDenied).toBeNull();
      expect(bare.isReady).toBe(true);
      return;
    }

    // Refused for the most specific requirement declared.
    const expectedKind = gate.systemAdminOnly ? 'systemAdmin' : gate.adminOnly ? 'admin' : 'permission';
    expect(bare.accessDenied).toEqual(expect.objectContaining({ kind: expectedKind, pathname: route }));
    if (expectedKind === 'permission') expect(bare.accessDenied?.permission).toBe(gate.permission);

    // …and admitted by a viewer who meets exactly that declaration.
    const qualified: Partial<User> = gate.systemAdminOnly
      ? { id: 'u2', isSuperAdmin: true }
      : { id: 'u2', role: gate.adminOnly ? 'admin' : 'member', permissions: gate.permission ? [gate.permission] : [] };
    const admitted = guardAt(route, qualified);
    expect(admitted.accessDenied).toBeNull();
    expect(admitted.isReady).toBe(true);
  });

  it('treats an undeclared route as open rather than blacking it out', () => {
    expect(guardAt('/dashboard/not-a-real-page', MEMBER).accessDenied).toBeNull();
  });
});
