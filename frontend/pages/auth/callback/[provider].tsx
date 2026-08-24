// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { XCircle, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import api from '@/lib/api';

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
 *   - kind 'invite' → POST /invitation/accept-oauth (verifies the code server-side
 *     and creates/links the invitee). That endpoint issues NO session tokens, so to
 *     establish a session we then start a fresh normal OAuth login (a new code/state)
 *     and let the second callback log the user in.
 *
 * The `state` itself is validated server-side; the client stores it only to carry
 * the intent across the redirect. No PKCE is involved.
 */

const OAUTH_INTENT_KEY = 'pb_oauth_intent';

interface OAuthIntent {
  state: string;
  kind: 'login' | 'invite';
  inviteToken?: string;
  returnUrl?: string;
}

function readIntent(): OAuthIntent | null {
  try {
    const raw = sessionStorage.getItem(OAUTH_INTENT_KEY);
    return raw ? (JSON.parse(raw) as OAuthIntent) : null;
  } catch {
    return null;
  }
}

/** Only permit same-site relative return URLs — never an attacker-supplied absolute
 *  URL (open-redirect). Falls back to the dashboard. */
function safeReturnUrl(url: string | undefined): string {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
  return '/dashboard';
}

export default function OAuthCallbackPage() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
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

    // Consume the stored intent immediately — it is single-use.
    const intent = readIntent();
    try { sessionStorage.removeItem(OAUTH_INTENT_KEY); } catch { /* storage unavailable */ }

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
      // back (continuity across the redirect). A mismatch means a stale/foreign
      // intent — ignore it and treat this as a plain login.
      const effective = intent && intent.state === state ? intent : null;

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

          const urlRes = await api.getOAuthUrl(provider);
          if (!urlRes.data?.url || !urlRes.data.state) throw new Error('Could not start sign-in with this provider');
          const next: OAuthIntent = { state: urlRes.data.state, kind: 'login', returnUrl: '/dashboard' };
          try { sessionStorage.setItem(OAUTH_INTENT_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
          window.location.href = urlRes.data.url;
          return;
        }

        // Plain login — establish the session exactly like password login.
        const res = await api.completeOAuthCallback(provider, { code, state });
        if (!res.success) throw new Error(res.message || 'Sign-in failed');
        await refreshUser();
        router.replace(safeReturnUrl(effective?.returnUrl));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      }
    };

    void run();
  }, [router.isReady, router.query, refreshUser, router]);

  return (
    <>
      <Head><title>Signing in… - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <Card className="p-8 text-center" role="status" aria-live="polite">
            {!error ? (
              <>
                <LoadingSpinner size="md" className="mx-auto mb-3" />
                <p className="font-bold">Completing sign-in…</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">Verifying your account.</p>
              </>
            ) : (
              <>
                <XCircle className="w-10 h-10 text-[var(--pb-danger)] mx-auto mb-3" />
                <p className="font-bold">Sign-in failed</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">{error}</p>
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
