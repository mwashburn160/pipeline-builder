// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared module mocks for page-level tests.
 *
 * `jest.mock` factories are hoisted above imports, so they load this module
 * lazily with `require`:
 *
 *   jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
 *   jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
 *   jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
 *
 * and import the same instances for assertions / per-test state:
 *
 *   import { pageToast, mockAuthGuard } from './helpers/pageMocks';
 *   const authGuard = mockAuthGuard({ isReadOnly: false });
 */

import type { ReactNode } from 'react';

// This helper isn't a *.test file, so the app's type check (`next build`, which
// skips only *.test/*.spec files) sees it without jest's value globals. Jest
// still provides `jest` to every module at runtime.
declare const jest: { fn: () => MockFn };

/** The slice of jest's mock-function API page tests use on these spies. */
export interface MockFn {
  (...args: unknown[]): unknown;
  mock: { calls: unknown[][] };
  mockClear(): MockFn;
  mockReset(): MockFn;
  mockImplementation(impl: (...args: unknown[]) => unknown): MockFn;
  mockResolvedValue(value: unknown): MockFn;
  mockRejectedValue(value: unknown): MockFn;
}

/** DashboardLayout reduced to a passthrough that still renders the page's header actions. */
export function dashboardLayoutModule() {
  return {
    __esModule: true,
    DashboardLayout: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
      <div>{actions}{children}</div>
    ),
  };
}

/** One toast spy object per test file; `clearMocks` resets the calls between tests. */
export const pageToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() };

export function toastModule() {
  return { __esModule: true, useToast: () => pageToast };
}

/** The subset of `useAuthGuard()` page tests read. Extra keys pass through. */
export interface PageAuthGuard {
  isReady: boolean;
  /** Set to a denial (see `AccessDenial`) to exercise a page's access-denied
   *  render; `null` (the default) is "the route's read gate passed". */
  accessDenied: { kind: 'permission' | 'admin' | 'systemAdmin'; permission?: string; pathname: string } | null;
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  isOrgAdminUser: boolean;
  isAdmin: boolean;
  isReadOnly: boolean;
  user: { id: string; organizationId?: string; [key: string]: unknown };
  can: (permission: string) => boolean;
  [key: string]: unknown;
}

const defaults = (): PageAuthGuard => ({
  isReady: true,
  accessDenied: null,
  isAuthenticated: true,
  isSuperAdmin: false,
  isOrgAdminUser: false,
  isAdmin: false,
  isReadOnly: false,
  user: { id: 'u1', organizationId: 'org-1' },
  can: () => false,
  logout: jest.fn(),
  refreshUser: jest.fn(),
});

let current: PageAuthGuard = defaults();

/**
 * Set what the mocked `useAuthGuard()` returns (defaults: a ready, signed-in,
 * non-admin member of org-1). Returns the live object, so a test can flip a
 * field (`authGuard.isReadOnly = true`) before rendering.
 */
export function mockAuthGuard(overrides: Partial<PageAuthGuard> = {}): PageAuthGuard {
  current = { ...defaults(), ...overrides };
  return current;
}

export function authGuardModule() {
  return { __esModule: true, useAuthGuard: () => current };
}

// ---------------------------------------------------------------------------
// useOrgHierarchy — the active org's place in the org → team hierarchy.

export interface PageOrgHierarchy {
  /** The org the viewer is acting in. Surfaces that only exist for a REAL org
   *  (the Members page's team controls) read it, so it defaults to undefined —
   *  pass `activeOrg` to `mockOrgHierarchy` to make it present. */
  activeOrg: { id: string; name: string; tier: string } | undefined;
  isChildOrg: boolean;
  hasChildOrgs: boolean;
  childOrgCount: number;
  parentOrgId: string | undefined;
}

let currentHierarchy: PageOrgHierarchy = {
  activeOrg: undefined, isChildOrg: false, hasChildOrgs: false, childOrgCount: 0, parentOrgId: undefined,
};

/**
 * Set what the mocked `useOrgHierarchy()` returns. Default: a flat org (no
 * parent, no teams) — hierarchy surfaces hidden. `{ childOrgCount: n }` makes
 * it a parent; `{ parentOrgId }` makes it a team.
 */
export function mockOrgHierarchy(
  overrides: { childOrgCount?: number; parentOrgId?: string; activeOrg?: { id: string; name: string; tier: string } } = {},
): PageOrgHierarchy {
  const childOrgCount = overrides.childOrgCount ?? 0;
  currentHierarchy = {
    activeOrg: overrides.activeOrg,
    isChildOrg: !!overrides.parentOrgId,
    hasChildOrgs: childOrgCount > 0,
    childOrgCount,
    parentOrgId: overrides.parentOrgId,
  };
  return currentHierarchy;
}

export function orgHierarchyModule() {
  return { __esModule: true, useOrgHierarchy: () => currentHierarchy };
}
