// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback } from 'react';
import type { NextRouter } from 'next/router';
import api from '@/lib/api';
import { takeReturnPath } from '@/lib/return-to';
import { PASSKEY_ENROLMENT_HREF } from '@/lib/security-links';

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
   *. A real session was opened, but it reaches only enrolment, sign-out
   *  and the setup routes, so the caller lands them on enrolment rather than on
   *  a dashboard whose every panel would answer 403. */
  | { status: 'mfa_enrollment_pending' };

interface UseLoginActionsDeps {
  /** Re-reads the profile once the backend has opened a session. */
  refreshUser: () => Promise<void>;
  /**
   * Marks a sign-in submission in flight. Deliberately NOT the provider's
   * `isLoading`: that flag means "the session state is unknown" and the landing
   * page swaps itself for a loader while it is set — so a password submit used
   * to unmount the very card that had to show the MFA prompt (or the error).
   */
  setIsSubmitting: (submitting: boolean) => void;
  router: NextRouter;
}

/**
 * The five ways a session gets opened: password, MFA completion, a forced
 * password change, a passkey, and registration (which finishes by signing in).
 *
 * They are siblings, not layers — each one calls the backend, then runs the
 * SAME post-sign-in half: refresh the profile and navigate to the return path
 * (unless the caller opted out with `redirect: false` because it has follow-up
 * work to do on the page first, like the invite-accept flow). Only that shared
 * tail plus `setIsSubmitting` connects them to the rest of `AuthProvider`, so they
 * live here instead of inside a 400-line provider next to the session state.
 *
 * The navigation is AWAITED before the submission clears. The landing page also
 * redirects an authenticated visitor, but it holds off while a submission is in
 * flight — so the action's own destination (the return path, or passkey
 * enrolment for a bootstrap administrator) is the one that wins, instead of
 * being overridden by a second push the moment the profile refresh lands.
 */
export function useLoginActions({ refreshUser, setIsSubmitting, router }: UseLoginActionsDeps) {
  /** Navigate unless the caller opted out; resolves once the route changed. */
  const go = useCallback(async (href: string, redirect: boolean | undefined) => {
    if (redirect === false) return;
    await router.push(href);
  }, [router]);

  /**
   * Login with email/username and password
   */
  const login = useCallback(async (email: string, password: string, opts?: { redirect?: boolean }): Promise<LoginResult> => {
    setIsSubmitting(true);

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

      // Bootstrap-admin enrolment session: send them to the security
      // settings, which is the only place this session can usefully go. The
      // exception closes the moment they enrol, after which an ordinary sign-in
      // behaves normally.
      if (response.data?.mfaEnrollmentPending) {
        await go(PASSKEY_ENROLMENT_HREF, opts?.redirect);
        return { status: 'mfa_enrollment_pending' };
      }

      // Use Next.js router for client-side navigation. Callers that need to
      // run follow-up work on the same page first (e.g. the invite-accept
      // flow, which must POST /invitation/accept before navigating away) pass
      // `redirect: false` and drive navigation themselves.
      await go(takeReturnPath(), opts?.redirect);
      return { status: 'complete' };
    } finally {
      setIsSubmitting(false);
    }
  }, [go, refreshUser, setIsSubmitting]);

  /**
   * Finish an MFA sign-in. Shares the post-sign-in half of `login` exactly — the
   * backend establishes the SAME session, so the only difference is that it took
   * two requests to prove who was asking.
   */
  const completeMfaLogin = useCallback(async (challengeId: string, code: string, opts?: { redirect?: boolean }): Promise<LoginResult> => {
    setIsSubmitting(true);
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
      await go(takeReturnPath(), opts?.redirect);
      return { status: 'complete' };
    } finally {
      setIsSubmitting(false);
    }
  }, [go, refreshUser, setIsSubmitting]);

  /**
   * Finish a sign-in whose password no longer met the org password policy: the
   * backend saves the new password (ending every other session of the account)
   * and opens the session the sign-in earned.
   */
  const completeRequiredPasswordChange = useCallback(async (challengeId: string, newPassword: string, opts?: { redirect?: boolean }): Promise<LoginResult> => {
    setIsSubmitting(true);
    try {
      const response = await api.completeRequiredPasswordChange({ challengeId, newPassword });
      if (!response.success) throw new Error(response.message || 'Could not change the password');
      await refreshUser();
      if (response.data?.mfaEnrollmentPending) {
        await go(PASSKEY_ENROLMENT_HREF, opts?.redirect);
        return { status: 'mfa_enrollment_pending' };
      }
      await go(takeReturnPath(), opts?.redirect);
      return { status: 'complete' };
    } finally {
      setIsSubmitting(false);
    }
  }, [go, refreshUser, setIsSubmitting]);

  /**
   * Sign in with a passkey.
   *
   * Shares the post-sign-in half of `login` exactly — the backend establishes
   * the SAME session (`issueTokens`, refresh cookie, session slot), so the only
   * difference is how the credential was presented.
   *
   * The submitting flag is deliberately NOT set while the autofill ceremony
   * waits: it sits in the browser's dropdown for as long as the person takes to
   * notice it, and a sign-in form disabled that whole time would be unusable.
   * It IS set once the ceremony resolves, so the post-sign-in navigation is not
   * overridden by the landing page's own redirect.
   */
  const loginWithPasskey = useCallback(async (opts?: { autofill?: boolean; redirect?: boolean }) => {
    const { signInWithPasskey } = await import('@/lib/passkeys');
    if (!opts?.autofill) setIsSubmitting(true);
    try {
      await signInWithPasskey({ autofill: opts?.autofill });
      if (opts?.autofill) setIsSubmitting(true);
      await refreshUser();
      await go(takeReturnPath(), opts?.redirect);
    } finally {
      setIsSubmitting(false);
    }
  }, [go, refreshUser, setIsSubmitting]);

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
    setIsSubmitting(true);

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
      setIsSubmitting(false);
    }
  }, [login, setIsSubmitting]);

  return { login, completeMfaLogin, completeRequiredPasswordChange, loginWithPasskey, register };
}
