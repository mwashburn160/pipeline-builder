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
 *   jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());
 *   jest.mock('next/head', () => require('./helpers/pageMocks').headModule());
 *   jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user })));
 *
 * The module helpers that take a `read` callback call it on every hook call,
 * so a test can keep the value in its own variable and reassign it per case.
 *
 * and import the same instances for assertions / per-test state:
 *
 *   import { pageToast, mockAuthGuard } from './helpers/pageMocks';
 *   const authGuard = mockAuthGuard({ isReadOnly: false });
 */

import { jest } from '@jest/globals';
import type { AnyFn } from './mock-fn';
import type { ReactNode } from 'react';

// `jest` comes from `@jest/globals` — a real, self-typed module — so this helper
// type-checks anywhere, including under `next build` (which checks non-test
// files without jest's globals).

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
export const pageToast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), info: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>() };

/** `read` supplies a test's own toast spies (read on every `useToast()` call). */
export function toastModule(read: () => unknown = () => pageToast) {
  return { __esModule: true, useToast: () => read() };
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
  logout: jest.fn<AnyFn>(),
  refreshUser: jest.fn<AnyFn>(),
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

/** `read` supplies a test's own guard value instead of {@link mockAuthGuard}'s. */
export function authGuardModule(read: () => unknown = () => current) {
  return { __esModule: true, useAuthGuard: () => read() };
}

// ---------------------------------------------------------------------------
// next/router, next/head, useAuth

/** The `next/router` fields components read. Extra keys pass through. */
export interface PageRouter {
  pathname: string;
  asPath: string;
  query: Record<string, string | string[] | undefined>;
  isReady: boolean;
  push: jest.Mock<AnyFn>;
  replace: jest.Mock<AnyFn>;
  back: jest.Mock<AnyFn>;
  prefetch: jest.Mock<AnyFn>;
  events: { on: jest.Mock<AnyFn>; off: jest.Mock<AnyFn>; emit: jest.Mock<AnyFn> };
  [key: string]: unknown;
}

const routerDefaults = (): PageRouter => ({
  pathname: '/',
  asPath: '/',
  query: {},
  isReady: true,
  push: jest.fn<AnyFn>(async () => true),
  replace: jest.fn<AnyFn>(async () => true),
  back: jest.fn<AnyFn>(),
  prefetch: jest.fn<AnyFn>(async () => undefined),
  events: { on: jest.fn<AnyFn>(), off: jest.fn<AnyFn>(), emit: jest.fn<AnyFn>() },
});

let currentRouter: PageRouter = routerDefaults();
/** Fallbacks for fields a `routerModule(read)` value leaves out. Built once, so
 *  `push` & co. keep their identity across renders. */
const routerBase: PageRouter = routerDefaults();

/**
 * Set what the mocked `useRouter()` returns (defaults: a ready router at `/`
 * with jest.fn navigation). Returns the live object, so a test can change a
 * field (`router.query = { tab: 'keys' }`) before rendering.
 */
export function mockRouter(overrides: Partial<PageRouter> = {}): PageRouter {
  currentRouter = { ...routerDefaults(), ...overrides };
  return currentRouter;
}

/**
 * `next/router` with `useRouter()` returning {@link mockRouter}'s value, or —
 * with `read` — the test's own fields over the defaults.
 */
export function routerModule(read?: () => Partial<PageRouter>) {
  // One live view per distinct `read()` value: a test that hands back the same
  // object every call gets a STABLE router (components memoize on it), and a
  // field it mutates later (`mockRouter.query = …`) is seen at once.
  const views = new WeakMap<object, PageRouter>();
  const useRouter = () => {
    if (!read) return currentRouter;
    const fields = read();
    let router = views.get(fields);
    if (!router) {
      router = new Proxy(fields, {
        get: (target, key) => (key in target ? Reflect.get(target, key) : Reflect.get(routerBase, key)),
        has: (target, key) => key in target || key in routerBase,
      }) as PageRouter;
      views.set(fields, router);
    }
    return router;
  };
  return { __esModule: true, useRouter };
}

/** `next/head` rendering its children in place. */
export function headModule() {
  return { __esModule: true, default: ({ children }: { children: ReactNode }) => <>{children}</> };
}

/** `@/hooks/useAuth` whose `useAuth()` returns `read()` on every call. */
export function authModule(read: () => unknown) {
  return { __esModule: true, useAuth: () => read() };
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
  parentOrgName: string | undefined;
  /** The viewer reaches this org as an admin of its parent (no membership row). */
  viaAncestor: boolean;
  childOrgs: Array<{ id: string; name: string }>;
  teamName: (orgId: string) => string;
}

let currentHierarchy: PageOrgHierarchy = {
  activeOrg: undefined, isChildOrg: false, hasChildOrgs: false, childOrgCount: 0,
  parentOrgId: undefined, parentOrgName: undefined, viaAncestor: false,
  childOrgs: [], teamName: (orgId: string) => orgId,
};

/**
 * Set what the mocked `useOrgHierarchy()` returns. Default: a flat org (no
 * parent, no teams) — hierarchy surfaces hidden. `{ childOrgCount: n }` makes
 * it a parent; `{ parentOrgId }` makes it a team.
 */
export function mockOrgHierarchy(
  overrides: {
    childOrgCount?: number;
    parentOrgId?: string;
    parentOrgName?: string;
    viaAncestor?: boolean;
    childOrgs?: Array<{ id: string; name: string }>;
    activeOrg?: { id: string; name: string; tier: string };
  } = {},
): PageOrgHierarchy {
  const childOrgCount = overrides.childOrgCount ?? 0;
  const childOrgs = overrides.childOrgs ?? [];
  currentHierarchy = {
    activeOrg: overrides.activeOrg,
    isChildOrg: !!overrides.parentOrgId,
    hasChildOrgs: childOrgCount > 0,
    childOrgCount,
    parentOrgId: overrides.parentOrgId,
    parentOrgName: overrides.parentOrgName,
    viaAncestor: !!overrides.viaAncestor,
    childOrgs,
    teamName: (orgId: string) => childOrgs.find((o) => o.id === orgId)?.name ?? orgId,
  };
  return currentHierarchy;
}

export function orgHierarchyModule() {
  return { __esModule: true, useOrgHierarchy: () => currentHierarchy };
}
