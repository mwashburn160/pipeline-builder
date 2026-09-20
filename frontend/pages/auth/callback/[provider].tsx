// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { takeReturnPath } from '@/lib/return-to';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { XCircle, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import api from '@/lib/api';
import { startOAuthLogin, takeOAuthIntent } from '@/lib/oauth-intent';
import { isReauthState, publishReauthResult } from '@/lib/step-up-reauth';
import { formatError } from '@/lib/constants';

/**
 * OAuth / SSO callback landing page.
 *
 * The provider redirects here after the user authorizes. The path is dictated by
 * the backend: `config.oauth.callbackBaseUrl` + `/auth/callback/:provider` is the
 * `redirect_uri` registered with Google/GitHub (see platform `controllers/oauth.ts`),
 * so this file MUST live at `pages/auth/callback/[provider].tsx` to match it.
 *
 * The provider appends `?code=…&state=…` to that URL. Because the SAME redirect_uri
 * serves both plain login and invite-accept, this page disambiguates via a
 * `sessionStorage` "intent" written just before the browser was sent to the
 * provider (keyed by the CSRF `state` the backend minted):
 *
 *   - kind 'login'  → POST /auth/oauth/:provider/callback, which returns the SAME
 *     token pair as password login; `completeOAuthCallback` applies it via the same
 *     `core.applyTokens` path, then we `refreshUser()` and land on the return URL.
 *   - a `reauth.`-prefixed state → this is a STEP-UP re-auth, not a sign-in: the
 *     page is a popup, so it hands `code`/`state` back to the window that opened
 *     it (which holds the session and the gated action) and closes itself.
 *   - kind 'invite' → POST /invitation/accept-oauth (verifies the code server-side
 *     and creates/links the invitee). That endpoint issues NO session tokens, so to
 *     establish a session we then start a fresh normal OAuth login (a new code/state)
 *     and let the second callback log the user in.
 *
 * The `state` itself is validated server-side; the client stores it only to carry
 * the intent across the redirect. No PKCE is involved.
 */

export default function OAuthCallbackPage() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // A step-up re-auth popup that has handed its result back to the app window.
  const [reauth, setReauth] = useState(false);
  // Single-use code/state — guard against React 18 strict-mode double-invoke.
  const started = useRef(false);

  useEffect(() => {
    if (!router.isReady || started.current) return;
    started.current = true;

    const provider = typeof router.query.provider === 'string' ? router.query.provider : '';
    const code = typeof router.query.code === 'string' ? router.query.code : '';
    const state = typeof router.query.state === 'string' ? router.query.state : '';
    // Providers report user-denied / config errors via `?error=access_denied` etc.
    const providerError = typeof router.query.error === 'string' ? router.query.error : '';

    // Step-up re-auth (see src/lib/step-up-reauth): the server minted this state
    // for a signed-in user, so no session is established here — hand the result
    // to the window that opened this popup and close. Checked BEFORE the sign-in
    // intent so a re-auth never walks into (or consumes) the login branches.
    if (isReauthState(state)) {
      publishReauthResult({
        type: 'pb-step-up-reauth',
        state,
        ...(providerError
          ? { error: `Sign-in was cancelled or denied by the provider (${providerError}).` }
          : code ? { code } : { error: 'The provider returned no authorization code.' }),
      });
      setReauth(true);
      window.close();
      return;
    }

    // Consume the stored intent immediately — it is single-use.
    const intent = takeOAuthIntent();

    const run = async () => {
      if (providerError) {
        setError(`Sign-in was cancelled or denied by the provider (${providerError}).`);
        return;
      }
      if (!provider || !code || !state) {
        setError('This sign-in link is missing its authorization code or state.');
        return;
      }
      // If an intent was stored, its state must match the one the provider echoed
      // back (continuity across the redirect).
      //
      // A MISMATCH is a genuine anomaly (stale or foreign intent), and silently
      // downgrading it to a plain login is how an invite-accept turned into a
      // brand-new self-serve org: the invitation was never accepted and nothing
      // said so. Fail closed and let the user retry from the invitation link.
      //
      // A MISSING intent still falls through to plain login — a browser with
      // storage blocked must remain able to sign in, and the invite path now
      // refuses to start at all in that case (see `storeOAuthIntent(..., true)`),
      // so "was an invite, lost the intent" is no longer reachable from the app.
      if (intent && intent.state !== state) {
        setError('This sign-in link no longer matches your pending request. Please start again from the original link.');
        return;
      }
      const effective = intent;

      try {
        if (effective?.kind === 'invite' && effective.inviteToken) {
          // Invite-accept is Google-only on the backend — validate rather than
          // assert `as 'google'`, so a non-google provider fails clearly instead
          // of being silently mislabelled. (Narrows `provider` to 'google' below.)
          if (provider !== 'google') {
            setError('Invitations can only be accepted with Google sign-in.');
            return;
          }
          // First-time OAuth invite accept — verified server-side. Returns no
          // session tokens, so afterwards we kick off a normal OAuth login to
          // establish the session (the invitee is now a returning user).
          await api.acceptInvitationOAuth({
            token: effective.inviteToken,
            oauthProvider: provider,
            code,
            state,
          });

          await startOAuthLogin(provider, '/dashboard');
          return;
        }

        // Plain login — establish the session exactly like password login.
        const res = await api.completeOAuthCallback(provider, { code, state });
        if (!res.success) throw new Error(res.message || 'Sign-in failed');
        await refreshUser();
        router.replace(takeReturnPath(effective?.kind === 'login' ? effective.returnUrl : undefined));
      } catch (err) {
        setError(formatError(err, 'Sign-in failed. Please try again.'));
      }
    };

    void run();
  }, [router.isReady, router.query, refreshUser, router]);

  return (
    <>
      <Head><title>Signing in… - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <Card className="p-8 text-center" role="status" aria-live="polite">
            {reauth ? (
              <>
                <p className="font-bold">Confirmed</p>
                <p className="text-sm text-fg-muted mt-1">You can close this window.</p>
              </>
            ) : !error ? (
              <>
                <LoadingSpinner size="md" className="mx-auto mb-3" />
                <p className="font-bold">Completing sign-in…</p>
                <p className="text-sm text-fg-muted mt-1">Verifying your account.</p>
              </>
            ) : (
              <>
                <XCircle className="w-10 h-10 text-danger mx-auto mb-3" />
                <p className="font-bold">Sign-in failed</p>
                <p className="text-sm text-fg-muted mt-1">{error}</p>
                <LinkButton href="/" variant="primary" fullWidth className="text-sm mt-4">
                  Back to sign in
                </LinkButton>
              </>
            )}
          </Card>
        </motion.div>
      </div>
    </>
  );
}
