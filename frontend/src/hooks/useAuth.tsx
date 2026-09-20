import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useRouter } from 'next/router';
import { forgetReturnPath, rememberReturnPath, takeReturnPath } from '@/lib/return-to';
import { SessionMfaPolicy, User, UserOrgMembership } from '@/types';
import api, { ApiError } from '@/lib/api';
import { clearAttachmentImageCache } from '@/lib/attachment-image-cache';
import { clearQueryCache } from '@/lib/query-cache';
import { PASSKEY_ENROLMENT_HREF } from '@/lib/security-links';
import { clearPluginCache } from './usePlugins';

/**
 * Minimum gap between profile refreshes triggered by the tab becoming visible.
 *
 * The handler used to fire on EVERY `visibilitychange`, so alt-tabbing across a
 * few windows, or a screen-share preview flipping the tab, cost a `/auth/profile`
 * plus a `/user/organizations` round trip each time. The refresh exists to catch
 * a token that expired while browser timers were throttled in the background —
 * a minute's granularity is ample for that, and the API client still refreshes
 * the token on demand before any request that needs one.
 */
const VISIBILITY_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * What a password sign-in produced: a session, or a pending second factor.
 *
 * Modelled as a RESULT rather than a thrown error because "we need your code" is
 * a normal step of a successful sign-in, not a failure — and because the
 * challenge handle has to reach the caller somehow.
 */
export type LoginResult =
  | { status: 'complete' }
  | { status: 'mfa_required'; challengeId: string; expiresAt: number }
  /** The password was right but no longer meets the org password policy: no
   *  session yet — the caller collects a NEW password (at least `minLength`)
   *  and calls `completeRequiredPasswordChange`. */
  | { status: 'password_change_required'; challengeId: string; expiresAt: number; minLength: number }
  /** The install's bootstrap administrator signed in before enrolling any factor
   *  (#8). A real session was opened, but it reaches only enrolment, sign-out
   *  and the setup routes, so the caller lands them on enrolment rather than on
   *  a dashboard whose every panel would answer 403. */
  | { status: 'mfa_enrollment_pending' };

/**
 * Auth context shape.
 *
 * Supports multi-org membership: `organizations` lists all orgs the user
 * belongs to (via UserOrganization), and `switchOrganization` re-issues
 * tokens scoped to a different org (calls `POST /auth/switch-org`).
 * After switching, `user.role` and `user.organizationId` reflect the new org.
 */
interface AuthContextType {
  user: User | null;
  /** All organizations the user belongs to, fetched from GET /user/organizations */
  organizations: UserOrgMembership[];
  isLoading: boolean;
  isAuthenticated: boolean;
  isInitialized: boolean;
  /** True while the session is a read-only sysadmin impersonation token
   *  (`impersonationReadOnly` claim). The backend rejects every non-GET request
   *  under such a token, so the UI must disable write affordances — see the
   *  `can()` gate in `useAuthGuard` and the ImpersonationBanner. */
  isReadOnly: boolean;
  /** Set when a profile refresh failed for a transient reason (network / 5xx)
   *  rather than a genuine 401. The prior user is kept; callers can retry
   *  via `refreshUser`. Cleared on the next successful refresh. */
  authError: Error | null;
  /** Sign in with a password. Resolves to `{ status: 'complete' }` when the
   *  session is open, or `{ status: 'mfa_required', … }` when the account has an
   *  authenticator app — the caller then collects a code and calls
   *  `completeMfaLogin`. Callers that ignore the result simply don't sign in an
   *  MFA account, never sign one in halfway. */
  login: (email: string, password: string, opts?: { redirect?: boolean }) => Promise<LoginResult>;
  /** Second leg of a password sign-in: exchange the challenge plus a code (from
   *  the app, or a recovery code) for the session. */
  completeMfaLogin: (challengeId: string, code: string, opts?: { redirect?: boolean }) => Promise<LoginResult>;
  /** Last leg of a sign-in whose password no longer meets the org policy: the
   *  challenge plus a compliant NEW password → the session. */
  completeRequiredPasswordChange: (challengeId: string, newPassword: string, opts?: { redirect?: boolean }) => Promise<LoginResult>;
  /** Sign in with a passkey. `autofill` runs the ceremony as browser
   *  "conditional UI" — it waits silently in the sign-in field's dropdown
   *  instead of opening a prompt. Post-sign-in handling (profile refresh,
   *  redirect) is identical to `login`. */
  loginWithPasskey: (opts?: { autofill?: boolean; redirect?: boolean }) => Promise<void>;
  register: (username: string, email: string, password: string, organizationName?: string, planId?: string, opts?: { redirect?: boolean; invitationToken?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: (opts?: { force?: boolean }) => Promise<void>;
  /** Switch active organization. Re-issues tokens and refreshes user profile with the new org's role. */
  switchOrganization: (orgId: string) => Promise<void>;
  /** Optimistically clear the local `needsOnboarding` flag after the onboarding
   *  endpoint succeeds — so the auth guard won't bounce the user back to the
   *  onboarding screen if the follow-up profile refresh transiently fails. */
  markOnboardingComplete: () => void;
}

/** Raw user shape from the backend (may use _id/sub instead of id) */
interface RawUserData {
  id?: string;
  sub?: string;
  _id?: { toString(): string };
  username: string;
  email: string;
  role: string;
  organizationId?: string;
  organizationName?: string;
  isSuperAdmin?: boolean;
  isEmailVerified?: boolean;
  needsOnboarding?: boolean;
  tier?: string;
  features?: string[];
  permissions?: string[];
  featureOverrides?: Record<string, boolean>;
  /** The active org's two-factor requirement (#8), when it has one. */
  mfaPolicy?: SessionMfaPolicy;
  createdAt?: string;
  updatedAt?: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Keep the previous value when the new one is structurally identical.
 *
 * The profile is re-fetched on every tab refocus. Handing consumers a NEW but
 * equal object would re-run every effect keyed on it — resetting forms the user
 * is typing in and reloading whole pages — for a profile that didn't change.
 */
function keepIfUnchanged<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/**
 * Drop per-session client caches so nothing leaks into the next session/org.
 *
 * `clearQueryCache` is the tenant boundary for the shared read cache: it empties
 * every entry AND bumps a generation so a request already in flight under the
 * previous org cannot land in the next one's cache. This is what makes it safe
 * for the app shell to stop remounting the whole page subtree on navigation —
 * the reset is now explicit instead of a side effect of a re-key.
 */
function clearSessionCaches(): void {
  clearPluginCache();
  clearAttachmentImageCache();
  clearQueryCache();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<UserOrgMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [authError, setAuthError] = useState<Error | null>(null);
  const router = useRouter();
  // Single-flight guard: coalesce concurrent refreshes (e.g. a tab-focus storm)
  // into one in-flight request. This both avoids redundant profile fetches and
  // prevents a late-resolving stale response from clobbering a newer one.
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshGenRef = useRef(0);
  /** Epoch ms of the last tab-focus-triggered refresh (see the throttle below). */
  const lastVisibilityRefreshRef = useRef(0);

  /**
   * Refresh user profile from API
   * Uses useCallback to maintain stable reference
   */
  const refreshUser = useCallback(async (opts?: { force?: boolean }) => {
    // `force` bypasses coalescing so a caller that just changed identity (e.g.
    // switchOrganization swapped the token) gets a FRESH fetch instead of the
    // in-flight one that ran under the previous token.
    if (!opts?.force && refreshInFlightRef.current) return refreshInFlightRef.current;
    // Generation guard: only the LATEST refresh may apply its result. A stale
    // in-flight refresh (older token / pre-switch) that resolves late is
    // discarded, so it can't clobber the newer identity's profile.
    const gen = ++refreshGenRef.current;
    const run = (async () => {
    try {
      if (api.isAuthenticated()) {
        const response = await api.getProfile();
        if (gen !== refreshGenRef.current) return; // superseded by a newer refresh

        const rawUser = response.data?.user as RawUserData | undefined;

        if (response.success && rawUser) {
          // Normalize user data - backend uses _id/sub, frontend uses id
          const userData: User = {
            id: rawUser.id || rawUser.sub || rawUser._id?.toString() || '',
            username: rawUser.username,
            email: rawUser.email,
            role: rawUser.role as User['role'],
            organizationId: rawUser.organizationId,
            organizationName: rawUser.organizationName,
            // Sysadmin claim from the JWT — gates sysadmin-only routes
            // (Registry, Build Queue, All Users, etc.) via isSystemAdmin().
            // Missing here previously, so the sidebar filter always saw false.
            isSuperAdmin: rawUser.isSuperAdmin === true,
            isEmailVerified: rawUser.isEmailVerified ?? false,
            needsOnboarding: rawUser.needsOnboarding === true,
            tier: rawUser.tier as User['tier'],
            features: rawUser.features,
            permissions: rawUser.permissions,
            featureOverrides: rawUser.featureOverrides,
            // Drives the MFA banner. Only present when the org requires it, so
            // the field is simply absent for everyone else.
            ...(rawUser.mfaPolicy ? { mfaPolicy: rawUser.mfaPolicy } : {}),
            createdAt: rawUser.createdAt,
            updatedAt: rawUser.updatedAt,
          };
          
          setUser((prev) => keepIfUnchanged(prev, userData));
          setAuthError(null);
          // Set organization ID for API requests
          if (userData.organizationId) {
            api.setOrganizationId(userData.organizationId);
          }
          // Profile endpoint never returns `organizations`; always fetch separately.
          try {
            const orgRes = await api.getUserOrganizations();
            const orgs = (orgRes.data?.organizations || []).map(o => ({
              id: o.organizationId,
              name: o.organizationName,
              slug: o.slug,
              role: o.role as UserOrgMembership['role'],
              parentOrgId: o.parentOrgId,
              parentOrgName: o.parentOrgName,
              ...(o.viaAncestor ? { viaAncestor: true } : {}),
              tier: o.tier as UserOrgMembership['tier'],
              childOrgCount: o.childOrgCount ?? 0,
            }));
            setOrganizations((prev) => keepIfUnchanged(prev, orgs));
          } catch {
            setOrganizations((prev) => (prev.length === 0 ? prev : []));
          }
          return;
        }
        // Authenticated request returned an unexpected non-success envelope
        // (no user, but a 2xx). Treat as an invalid session.
        setUser(null);
        setAuthError(null);
        return;
      }
      // No token at all — genuinely signed out.
      setUser(null);
      setAuthError(null);
    } catch (err) {
      if (gen !== refreshGenRef.current) return; // superseded — don't apply stale error state
      // Only sign the user out on a genuine auth failure (401 — token expired
      // or revoked). A network blip or 5xx is transient: keep the current user
      // and surface a retryable error instead of silently logging them out.
      // (The api client already fires `onSessionExpired` when a refresh truly
      // fails, which clears state + redirects; this catch must not double as a
      // logout for every transient error.)
      if (err instanceof ApiError && err.statusCode === 401) {
        setUser(null);
        setAuthError(null);
      } else {
        setAuthError(err instanceof Error ? err : new Error('Failed to refresh session'));
      }
    }
    })();
    refreshInFlightRef.current = run;
    // Only clear the shared slot if it still points at THIS run (a concurrent
    // forced refresh may have replaced it).
    try { await run; } finally { if (refreshInFlightRef.current === run) refreshInFlightRef.current = null; }
  }, []);

  /**
   * Initialize auth state on mount
   */
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      // The access token lives in memory only, so every page load starts with
      // none. The session itself survives in the HttpOnly refresh cookie —
      // trade it for an access token before concluding "signed out".
      await api.restoreSession();
      await refreshUser();
      setIsLoading(false);
      setIsInitialized(true);
    };
    init();
  }, [refreshUser]);

  /**
   * Re-check token freshness when the tab becomes visible again.
   * Browser timers are throttled in background tabs, so the scheduled
   * proactive refresh may not have fired while the user was away.
   *
   * Throttled to {@link VISIBILITY_REFRESH_MIN_INTERVAL_MS}: a person moving
   * between two windows fires this event several times a minute, and each one
   * cost two requests for a profile that cannot have changed in the interval.
   */
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !api.isAuthenticated()) return;
      const now = Date.now();
      if (now - lastVisibilityRefreshRef.current < VISIBILITY_REFRESH_MIN_INTERVAL_MS) return;
      lastVisibilityRefreshRef.current = now;
      refreshUser();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refreshUser]);

  /**
   * Handle session expiry — API client fires this when refresh fails.
   * Redirects to login page and clears local state.
   */
  useEffect(() => {
    return api.onSessionExpired(() => {
      clearSessionCaches();
      setUser(null);
      // Remember where they were so signing back in returns them there.
      rememberReturnPath(router.asPath);
      router.push('/?expired=1');
    });
  }, [router]);

  /**
   * Login with email/username and password
   */
  const login = useCallback(async (email: string, password: string, opts?: { redirect?: boolean }): Promise<LoginResult> => {
    setIsLoading(true);

    try {
      const response = await api.login(email, password);
      if (!response.success) throw new Error(response.message || 'Login failed');

      // The account has an authenticator app: the password alone opened nothing,
      // and the caller owes a code. Nothing local changes — there is no session
      // to refresh and no page to navigate to yet.
      if (response.data?.mfaRequired && response.data.challengeId) {
        return {
          status: 'mfa_required',
          challengeId: response.data.challengeId,
          expiresAt: response.data.expiresAt ?? 0,
        };
      }

      // The password is right but below the org's password policy: nothing was
      // opened, and a new password is owed first.
      if (response.data?.passwordChangeRequired && response.data.challengeId) {
        return {
          status: 'password_change_required',
          challengeId: response.data.challengeId,
          expiresAt: response.data.expiresAt ?? 0,
          minLength: response.data.minLength ?? 0,
        };
      }

      await refreshUser();

      // Bootstrap-admin enrolment session (#8): send them to the security
      // settings, which is the only place this session can usefully go. The
      // exception closes the moment they enrol, after which an ordinary sign-in
      // behaves normally.
      if (response.data?.mfaEnrollmentPending) {
        if (opts?.redirect !== false) router.push(PASSKEY_ENROLMENT_HREF);
        return { status: 'mfa_enrollment_pending' };
      }

      // Use Next.js router for client-side navigation. Callers that need to
      // run follow-up work on the same page first (e.g. the invite-accept
      // flow, which must POST /invitation/accept before navigating away) pass
      // `redirect: false` and drive navigation themselves.
      if (opts?.redirect !== false) router.push(takeReturnPath());
      return { status: 'complete' };
    } finally {
      setIsLoading(false);
    }
  }, [refreshUser, router]);

  /**
   * Finish an MFA sign-in. Shares the post-sign-in half of `login` exactly — the
   * backend establishes the SAME session, so the only difference is that it took
   * two requests to prove who was asking.
   */
  const completeMfaLogin = useCallback(async (challengeId: string, code: string, opts?: { redirect?: boolean }): Promise<LoginResult> => {
    setIsLoading(true);
    try {
      const response = await api.verifyMfaLogin({ challengeId, code });
      if (!response.success) throw new Error(response.message || 'Verification failed');
      // Both factors verified, but the password owes a change before any session.
      if (response.data?.passwordChangeRequired && response.data.challengeId) {
        return {
          status: 'password_change_required',
          challengeId: response.data.challengeId,
          expiresAt: response.data.expiresAt ?? 0,
          minLength: response.data.minLength ?? 0,
        };
      }
      await refreshUser();
      if (opts?.redirect !== false) router.push(takeReturnPath());
      return { status: 'complete' };
    } finally {
      setIsLoading(false);
    }
  }, [refreshUser, router]);

  /**
   * Finish a sign-in whose password no longer met the org password policy: the
   * backend saves the new password (ending every other session of the account)
   * and opens the session the sign-in earned.
   */
  const completeRequiredPasswordChange = useCallback(async (challengeId: string, newPassword: string, opts?: { redirect?: boolean }): Promise<LoginResult> => {
    setIsLoading(true);
    try {
      const response = await api.completeRequiredPasswordChange({ challengeId, newPassword });
      if (!response.success) throw new Error(response.message || 'Could not change the password');
      await refreshUser();
      if (response.data?.mfaEnrollmentPending) {
        if (opts?.redirect !== false) router.push(PASSKEY_ENROLMENT_HREF);
        return { status: 'mfa_enrollment_pending' };
      }
      if (opts?.redirect !== false) router.push(takeReturnPath());
      return { status: 'complete' };
    } finally {
      setIsLoading(false);
    }
  }, [refreshUser, router]);

  /**
   * Sign in with a passkey.
   *
   * Shares the post-sign-in half of `login` exactly — the backend establishes
   * the SAME session (`issueTokens`, refresh cookie, session slot), so the only
   * difference is how the credential was presented.
   *
   * `isLoading` is deliberately NOT set for the autofill ceremony: it sits
   * waiting in the browser's dropdown for as long as the person takes to notice
   * it, and a sign-in form disabled that whole time would be unusable.
   */
  const loginWithPasskey = useCallback(async (opts?: { autofill?: boolean; redirect?: boolean }) => {
    const { signInWithPasskey } = await import('@/lib/passkeys');
    if (!opts?.autofill) setIsLoading(true);
    try {
      await signInWithPasskey({ autofill: opts?.autofill });
      await refreshUser();
      if (opts?.redirect !== false) router.push(takeReturnPath());
    } finally {
      if (!opts?.autofill) setIsLoading(false);
    }
  }, [refreshUser, router]);

  /**
   * Register new user
   */
  const register = useCallback(async (
    username: string,
    email: string,
    password: string,
    organizationName?: string,
    planId?: string,
    opts?: { redirect?: boolean; invitationToken?: string }
  ) => {
    setIsLoading(true);

    try {
      // Registering to accept an invitation names it, so the INVITING org's
      // password policy applies to the new password.
      const response = await api.register(username, email, password, organizationName, planId, opts?.invitationToken);

      if (!response.success) {
        throw new Error(response.message || 'Registration failed');
      }

      // `POST /auth/register` creates the user+org but does NOT issue tokens
      // (it returns `{ user }`, 201 — no accessToken/cookie). Without this the
      // new user landed back on the login screen and had to re-enter the same
      // credentials. Authenticate immediately with the same email/password to
      // establish the session exactly like the login path (stores the token
      // pair + refreshes the profile). `login` also routes to the return-to path
      // (unless the caller opted out via `redirect: false`).
      await login(email, password, { redirect: opts?.redirect });
    } finally {
      setIsLoading(false);
    }
  }, [login]);

  /**
   * Switch active organization — re-issues tokens and refreshes user profile.
   */
  const switchOrganization = useCallback(async (orgId: string) => {
    await api.switchOrganization(orgId);
    // Drop the previous org's cached plugins/attachments before loading the new
    // org's profile — the module-level caches would otherwise leak Org A's data
    // into the Org B session.
    clearSessionCaches();
    // Force a fresh, non-coalesced refresh under the NEW org's token — a refresh
    // already in flight under the previous token must not satisfy this reload.
    await refreshUser({ force: true });
  }, [refreshUser]);

  const markOnboardingComplete = useCallback(() => {
    setUser((u) => (u ? { ...u, needsOnboarding: false } : u));
  }, []);

  /**
   * Logout user
   */
  const logout = useCallback(async () => {
    setIsLoading(true);
    
    try {
      await api.logout();
    } finally {
      clearSessionCaches();
      setUser(null);
      setIsLoading(false);
      // Navigate to landing page. A deliberate sign-out returns nowhere: the
      // auth guard remembers the page it bounces from as `user` clears, so the
      // remembered path is dropped once the navigation has happened.
      void Promise.resolve(router.push('/')).finally(forgetReturnPath);
    }
  }, [router]);

  // Derived from the current access token's `impersonationReadOnly` claim.
  //
  // Held in STATE, not read from the client at render time. The token lives in
  // the api client, which React cannot observe: a render that happened to run
  // before the token was adopted (or after a sibling tab's broadcast swapped it)
  // kept its stale answer until something unrelated re-rendered the provider.
  // Reading it during render was also a server/client hydration hazard — the
  // server never has a token, the browser may restore one from sessionStorage
  // before the first paint. Syncing in an effect keyed on the profile covers
  // every path that can change it: init, sign-in, org switch, stop-impersonation
  // and the cross-tab token handoff all refresh the profile.
  const [isReadOnly, setIsReadOnly] = useState(false);
  useEffect(() => {
    setIsReadOnly(api.isImpersonating());
  }, [user, isInitialized]);

  // Memoized so a provider re-render with nothing changed doesn't hand every
  // consumer a new context object (and re-run their effects).
  const value = useMemo<AuthContextType>(() => ({
    user,
    organizations,
    isLoading,
    isAuthenticated: !!user,
    isInitialized,
    isReadOnly,
    authError,
    login,
    completeMfaLogin,
    completeRequiredPasswordChange,
    loginWithPasskey,
    register,
    logout,
    refreshUser,
    switchOrganization,
    markOnboardingComplete,
  }), [user, organizations, isLoading, isInitialized, isReadOnly, authError, login, completeMfaLogin, completeRequiredPasswordChange, loginWithPasskey, register, logout, refreshUser, switchOrganization, markOnboardingComplete]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
