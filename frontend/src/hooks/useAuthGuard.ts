// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level authentication guard hook.
 *
 * Redirects unauthenticated users to the login page, and enforces the route's
 * read gate — org-admin / system-admin / a fine-grained permission. The gate is
 * resolved from `src/lib/page-access.ts`, which derives it from the SAME
 * `NAV_SECTIONS` declaration the sidebar filters on, so a page needs no options
 * and the two can't drift. Explicit options still win when a page needs more
 * than its nav entry says.
 *
 * An authorization failure surfaces as `accessDenied` (render
 * `<AccessDenied>`), NOT as a redirect: a deep link, a bookmark or a
 * post-login bounce should say "you don't have access to this" once, rather
 * than render the full chrome and 403 panel by panel, or silently teleport the
 * viewer to /dashboard. `accessDenied` is derived on every render from the live
 * user profile, so losing the permission mid-session (a role change, an org
 * switch, an impersonation ending) flips the open page to the denied state
 * immediately instead of only being caught at mount.
 */
import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from './useAuth';
import { isSystemAdmin, isOrgAdmin, hasPermission, isMutationPermission } from '@/lib/auth-helpers';
import { resolvePageGate } from '@/lib/page-access';

/** Options for configuring the auth guard's requirements. */
interface AuthGuardOptions {
  /** Require the user to be an org admin or system admin. */
  requireAdmin?: boolean;
  /** Require the user to be a system admin specifically. */
  requireSystemAdmin?: boolean;
  /** Require a specific fine-grained permission (RBAC). Superadmins bypass. */
  requirePermission?: string;
  /** Set on the onboarding page itself so the guard doesn't bounce a
   *  `needsOnboarding` user away from it (which would loop). */
  allowOnboarding?: boolean;
}

/** Why the current viewer may not see this route. */
export interface AccessDenial {
  /** Which requirement failed — picks the sentence `<AccessDenied>` renders. */
  kind: 'permission' | 'admin' | 'systemAdmin';
  /** The permission id the route needs, when `kind === 'permission'`. */
  permission?: string;
  /** The route that was denied, so the message can name it (shared links). */
  pathname: string;
}

/**
 * Guards a page route by checking authentication and role requirements.
 * Redirects to `/` (landing page) if not authenticated, or to `/dashboard` if
 * the user lacks the required admin privileges.
 *
 * @param options - Optional role requirements (admin, system admin)
 * @returns User info, role flags, readiness state, and auth action callbacks
 */
export function useAuthGuard(options?: AuthGuardOptions) {
  const router = useRouter();
  const { user, isAuthenticated, isInitialized, isLoading, isReadOnly, logout, refreshUser } = useAuth();

  const isSuperAdmin = isSystemAdmin(user);
  const isOrgAdminUser = isOrgAdmin(user);
  const isAdmin = isSuperAdmin || isOrgAdminUser;

  // The route's declared gate (nav-derived). Options override per requirement so
  // a page can ask for MORE than its nav entry declares, never less by omission.
  const gate = resolvePageGate(router.pathname);
  const requireAdmin = options?.requireAdmin ?? gate.adminOnly ?? false;
  const requireSystemAdmin = options?.requireSystemAdmin ?? gate.systemAdminOnly ?? false;
  const allowOnboarding = options?.allowOnboarding ?? false;
  const needsOnboarding = !!user?.needsOnboarding;
  const requirePermission = options?.requirePermission ?? gate.permission;
  const hasRequiredPermission = !requirePermission || hasPermission(user, requirePermission);

  /**
   * Fine-grained permission check for the active org (RBAC UI gating).
   *
   * During a read-only impersonation session, mutation permissions
   * (`:write`/`:manage`/`org:settings`) always report false so write controls
   * disable app-wide — the backend rejects every non-GET request under an
   * impersonation token, so an enabled write button is only a 403 dead-end.
   * Read permissions are unaffected.
   *
   * Memoized so the reference stays stable across renders — consumers pass it
   * into `useMemo`/`useCallback` dependency arrays (e.g. the pipelines column
   * builder), which would otherwise recompute every render.
   */
  const can = useCallback(
    (permission: string) =>
      hasPermission(user, permission) && !(isReadOnly && isMutationPermission(permission)),
    [user, isReadOnly],
  );

  useEffect(() => {
    if (!isInitialized || isLoading) return;
    if (!isAuthenticated) {
      // replace (not push) so the guarded URL isn't left in history — otherwise
      // a signed-out user who lands on '/' and hits Back returns to the guarded
      // page, which immediately re-redirects (a "stuck" Back button).
      router.replace('/');
      return;
    }
    // Force first-run social-signup users through onboarding before any other
    // gated route (the onboarding page passes `allowOnboarding` to opt out and
    // avoid a redirect loop).
    if (needsOnboarding && !allowOnboarding && router.pathname !== '/dashboard/onboarding') {
      router.replace('/dashboard/onboarding');
      return;
    }
    // Authorization failures deliberately do NOT redirect — see `accessDenied`.
  }, [isAuthenticated, isInitialized, isLoading, router, needsOnboarding, allowOnboarding]);

  // Signed in, past onboarding, and the profile has loaded — only then can an
  // authorization verdict be meaningful (before that everything looks denied).
  const isSettled = isInitialized && !isLoading && isAuthenticated && !!user
    && (allowOnboarding || !needsOnboarding);

  // Recomputed every render from the live profile, so a permission LOST while the
  // page is open (role change, org switch, impersonation ending) flips the page
  // to the denied state rather than leaving stale panels to 403 one by one.
  const accessDenied: AccessDenial | null = !isSettled
    ? null
    : requireSystemAdmin && !isSuperAdmin
      ? { kind: 'systemAdmin', pathname: router.pathname }
      : requireAdmin && !isAdmin
        ? { kind: 'admin', pathname: router.pathname }
        : !hasRequiredPermission
          ? { kind: 'permission', permission: requirePermission, pathname: router.pathname }
          : null;

  const isReady = isSettled && accessDenied === null;

  return {
    user,
    isReady,
    /** Non-null when the route's read gate refuses this viewer. Pages render
     *  `<AccessDenied denial={accessDenied} />` before their loading state. */
    accessDenied,
    isAuthenticated,
    isSuperAdmin,
    isOrgAdminUser,
    isAdmin,
    /** True during a read-only sysadmin impersonation session — writes are
     *  blocked by the backend, so `can()` reports false for every mutation. */
    isReadOnly,
    can,
    logout,
    refreshUser,
  };
}
