// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { motion } from 'framer-motion';
import { XCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { isReauthState, publishReauthResult } from '@/lib/step-up-reauth';

/**
 * Per-org SSO callback landing page.
 *
 * The path is dictated by the backend: platform registers
 * `${callbackBaseUrl}/auth/sso/:orgId/callback` as the `redirect_uri` with the
 * org's IdP (see platform `services/oidc-service.ts` → `ssoCallbackUrl`), so
 * this file MUST live at `pages/auth/sso/[orgId]/callback.tsx`.
 *
 * What lands here today is a STEP-UP re-auth: an SSO-backed account confirming
 * its identity before a gated action (see src/lib/step-up-reauth). The page runs
 * in a popup, so it publishes the IdP's `code`/`state` to the window that opened
 * it — which holds the session — and closes.
 *
 * Any other arrival (an IdP-initiated redirect, a bookmarked callback URL) has
 * no pending request to attach to and is refused rather than silently turned
 * into a sign-in.
 */
export default function SsoCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Single-use code/state — guard against React 18 strict-mode double-invoke.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code') ?? '';
    const state = params.get('state') ?? '';
    // IdPs report user-denied / config failures via `?error=...`.
    const idpError = params.get('error') ?? '';

    if (!isReauthState(state)) {
      setError('This single sign-on link has no pending request. Start again from the action you were confirming.');
      return;
    }

    publishReauthResult({
      type: 'pb-step-up-reauth',
      state,
      ...(idpError
        ? { error: `Single sign-on was cancelled or denied by your identity provider (${idpError}).` }
        : code ? { code } : { error: 'Your identity provider returned no authorization code.' }),
    });
    setDone(true);
    window.close();
  }, []);

  return (
    <>
      <Head><title>Confirming… - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <Card className="p-8 text-center" role="status" aria-live="polite">
            {error ? (
              <>
                <XCircle className="w-10 h-10 text-[var(--pb-danger)] mx-auto mb-3" />
                <p className="font-bold">Single sign-on failed</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">{error}</p>
                <LinkButton href="/" variant="primary" fullWidth className="text-sm mt-4">
                  Back to sign in
                </LinkButton>
              </>
            ) : (
              <>
                <p className="font-bold">{done ? 'Confirmed' : 'Completing single sign-on…'}</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">
                  {done ? 'You can close this window.' : 'Verifying with your identity provider.'}
                </p>
              </>
            )}
          </Card>
        </motion.div>
      </div>
    </>
  );
}
