// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deep-link read gates, end to end.
 *
 * A bookmark or a shared link to a page the viewer can't read must produce ONE
 * honest refusal — not the full chrome followed by a 403 per panel, and not a
 * silent bounce to /dashboard that makes the link look broken. And the verdict
 * has to keep up with the session: a role change or an org switch while the page
 * is open flips it to the refusal, rather than leaving stale panels to fail.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, renderHook, screen } from '@testing-library/react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';

let pathname = '/dashboard/pipelines';
const push = jest.fn<AnyFn>();
const replace = jest.fn<AnyFn>();
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ pathname, push, replace, query: {}, isReady: true })));

interface TestUser { id: string; permissions?: string[]; isSuperAdmin?: boolean; role?: string }
let user: TestUser | null = { id: 'u1', permissions: ['pipelines:read'] };
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({
    user,
    isAuthenticated: !!user,
    isInitialized: true,
    isLoading: false,
    isReadOnly: false,
    logout: jest.fn<AnyFn>(),
    refreshUser: jest.fn<AnyFn>(),
  })));

describe('useAuthGuard resolves the route gate from the nav declaration', () => {
  beforeEach(() => {
    pathname = '/dashboard/pipelines';
    user = { id: 'u1', permissions: ['pipelines:read'] };
    push.mockClear();
    replace.mockClear();
  });

  it('lets a holder of the declared permission through', () => {
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied).toBeNull();
    expect(result.current.isReady).toBe(true);
  });

  it('denies a viewer without it — with the permission named, and no redirect', () => {
    user = { id: 'u1', permissions: ['messages:read'] };
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied).toEqual({
      kind: 'permission',
      permission: 'pipelines:read',
      pathname: '/dashboard/pipelines',
    });
    expect(result.current.isReady).toBe(false);
    // The old behaviour. A silent bounce is why a shared link "didn't work".
    expect(push).not.toHaveBeenCalled();
  });

  it('applies the gate with no options on the page at all', () => {
    // /dashboard/templates calls useAuthGuard() bare: the gate must still
    // apply, not render the gallery and then fail every fetch.
    pathname = '/dashboard/templates';
    user = { id: 'u1', permissions: ['pipelines:read'] };
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied?.permission).toBe('templates:read');
  });

  it('denies a non-sysadmin on a sysadmin route', () => {
    pathname = '/dashboard/registry';
    const { result } = renderHook(() => useAuthGuard({ requireSystemAdmin: true }));
    expect(result.current.accessDenied).toEqual({ kind: 'systemAdmin', pathname: '/dashboard/registry' });
  });

  it('lets a superadmin past every permission gate', () => {
    user = { id: 'root', isSuperAdmin: true, permissions: [] };
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied).toBeNull();
  });

  it('flips to denied when the permission is lost MID-SESSION', () => {
    const { result, rerender } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied).toBeNull();
    // A role change / org switch lands a new profile while the page is open.
    user = { id: 'u1', permissions: [] };
    rerender();
    expect(result.current.accessDenied?.kind).toBe('permission');
    expect(result.current.isReady).toBe(false);
  });

  it('returns no verdict before the session has settled', () => {
    // Denying while the profile is still loading would flash a refusal at
    // everyone on every cold load.
    user = null;
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied).toBeNull();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('leaves an open page open', () => {
    pathname = '/dashboard/help';
    user = { id: 'u1', permissions: [] };
    const { result } = renderHook(() => useAuthGuard());
    expect(result.current.accessDenied).toBeNull();
    expect(result.current.isReady).toBe(true);
  });
});

describe('<AccessDenied> says what is missing', () => {
  it('names the permission and the route', () => {
    render(<AccessDenied denial={{ kind: 'permission', permission: 'plugins:read', pathname: '/dashboard/plugins' }} />);
    expect(screen.getByTestId('access-denied')).toBeInTheDocument();
    expect(screen.getByText('plugins:read')).toBeInTheDocument();
    expect(screen.getByText('/dashboard/plugins')).toBeInTheDocument();
    expect(screen.getByText(/ask an owner or admin/i)).toBeInTheDocument();
  });

  it('does not tell a non-sysadmin to ask their org admin for operator access', () => {
    render(<AccessDenied denial={{ kind: 'systemAdmin', pathname: '/dashboard/registry' }} />);
    expect(screen.getByText(/system administrator access/i)).toBeInTheDocument();
    expect(screen.queryByText(/ask an owner or admin/i)).not.toBeInTheDocument();
  });
});
