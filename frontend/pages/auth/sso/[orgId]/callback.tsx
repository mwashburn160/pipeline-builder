// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { takeReturnPath } from '@/lib/return-to';
import { motion } from 'framer-motion';
import { XCircle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { isReauthState, publishReauthResult } from '@/lib/step-up-reauth';
import { isSsoTestState, publishSsoTestResult, SSO_TEST_CHANNEL } from '@/components/sso/test-channel';

/**
 * Per-org SSO (OIDC) callback landing page.
 *
 * The path is dictated by the backend: platform registers
 * `${callbackBaseUrl}/auth/sso/:orgId/callback` as the `redirect_uri` with the
 * org's IdP (see platform `services/oidc-service.ts` → `ssoCallbackUrl`), so
 * this file MUST live at `pages/auth/sso/[orgId]/callback.tsx`.
 *
 * ONE redirect_uri serves two flows, told apart by the `state` the backend
 * minted:
 *
 *   - a `reauth.`-prefixed state is a STEP-UP re-auth (src/lib/step-up-reauth):
 *     no session is established here, the page is a popup, so it hands
 *     `code`/`state` to the window that opened it and closes. Checked FIRST, so
 *     a re-auth can never be redeemed as a sign-in;
 *   - an `ssotest.`-prefixed state is an admin's TEST CONNECTION
 *     (components/sso/test-channel): likewise handed back to the settings page
 *     that opened the popup, never redeemed here — and the platform's sign-in
 *     callback would refuse it anyway (it lives in a separate state store);
 *   - anything else is a SIGN-IN that began at the login card's "Continue with
 *     single sign-on". The code is exchanged server-side (which is where the
 *     `id_token` is validated against the IdP's JWKS), and the session it
 *     returns is the same shape password login produces.
 *
 * An arrival with no code — a bookmarked callback URL, an IdP-initiated
 * redirect, a spent state — is refused rather than left spinning.
 */
export default function SsoCallbackPage() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // A step-up re-auth / test-connection popup that has handed its result back
  // to the app window.
  const [reauth, setReauth] = useState(false);
  // Single-use code/state — guard against React 18 strict-mode double-invoke.
  const started = useRef(false);

  const signIn = useCallback(async (orgId: string, code: string, state: string) => {
    try {
      const res = await api.completeSsoCallback(orgId, { code, state });
      if (!res.success) throw new Error(res.message || 'Single sign-on failed');
      await refreshUser();
      await router.replace(takeReturnPath());
    } catch (err) {
      // The backend states these refusals in plain words (OIDC_ERROR_MAP), so
      // the message it sends is the message to show — a local lookup table would
      // only drift away from it.
      setError(formatError(err, 'Single sign-on could not be completed. Please try again, or contact an administrator if it keeps happening.'));
    }
  }, [refreshUser, router]);

  useEffect(() => {
    if (!router.isReady || started.current) return;
    started.current = true;

    const orgId = typeof router.query.orgId === 'string' ? router.query.orgId : '';
    const code = typeof router.query.code === 'string' ? router.query.code : '';
    const state = typeof router.query.state === 'string' ? router.query.state : '';
    // IdPs report user-denied / config failures via `?error=...`.
    const idpError = typeof router.query.error === 'string' ? router.query.error : '';

    if (isReauthState(state)) {
      publishReauthResult({
        type: 'pb-step-up-reauth',
        state,
        ...(idpError
          ? { error: `Single sign-on was cancelled or denied by your identity provider (${idpError}).` }
          : code ? { code } : { error: 'Your identity provider returned no authorization code.' }),
      });
      setReauth(true);
      window.close();
      return;
    }

    if (isSsoTestState(state)) {
      publishSsoTestResult({
        type: SSO_TEST_CHANNEL,
        state,
        ...(idpError ? { error: idpError } : code ? { code } : { error: 'no_code' }),
      });
      setReauth(true);
      window.close();
      return;
    }

    if (idpError) {
      setError(`Single sign-on was cancelled or denied by your identity provider (${idpError}).`);
      return;
    }
    if (!orgId || !code || !state) {
      setError('This single sign-on link has no pending sign-in. Start again from the sign-in page.');
      return;
    }
    void signIn(orgId, code, state);
  }, [router.isReady, router.query, signIn]);

  return (
    <>
      <Head><title>Signing in… - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <Card className="p-8 text-center" role="status" aria-live="polite">
            {error ? (
              <>
                <XCircle className="w-10 h-10 text-danger mx-auto mb-3" />
                <p className="font-bold">Single sign-on failed</p>
                <p className="text-sm text-fg-muted mt-1">{error}</p>
                <LinkButton href="/" variant="primary" fullWidth className="text-sm mt-4">
                  Back to sign in
                </LinkButton>
              </>
            ) : reauth ? (
              <>
                <p className="font-bold">Confirmed</p>
                <p className="text-sm text-fg-muted mt-1">You can close this window.</p>
              </>
            ) : (
              <>
                <LoadingSpinner />
                <p className="font-bold mt-3">Completing single sign-on…</p>
                <p className="text-sm text-fg-muted mt-1">
                  Verifying with your identity provider.
                </p>
              </>
            )}
          </Card>
        </motion.div>
      </div>
    </>
  );
}
