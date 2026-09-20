// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import { XCircle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { publishSsoTestResult, SSO_TEST_CHANNEL } from '@/components/sso/test-channel';

/**
 * SAML 2.0 sign-in landing page.
 *
 * Where the browser arrives after the identity provider has POSTed its assertion
 * to the backend's Assertion Consumer Service (`/api/auth/sso/:orgId/saml/acs`).
 * SAML delivers the assertion by an IdP-driven form POST to a SERVER endpoint —
 * not by a redirect this page could read — so by the time we get here the
 * assertion has already been verified and the membership provisioned, and all
 * that is left in the URL is one of two things:
 *
 *   `?handoff=…` — a single-use, org-bound handle. Redeeming it is what MINTS
 *      the session, so the session records THIS browser and picks up the
 *      refresh-cookie transport (the `X-Pb-Client` header every request here
 *      carries). No token ever travels through a URL.
 *   `?error=…`   — the assertion was refused. The code is one of a fixed set the
 *      backend is willing to state publicly; anything else arrives as
 *      `SAML_ERROR` and gets the generic message.
 *   `?test=…`    — an admin's TEST CONNECTION: the ACS verified the assertion in
 *      dry-run mode and parked a report. This popup only hands the test `state`
 *      back to the settings page that opened it (which collects the report over
 *      its own authenticated session) and closes — no session is minted here.
 *
 * The path is dictated by the backend (`samlLandingUrl` in platform
 * `services/saml-service.ts`), so this file MUST live at
 * `pages/auth/sso/[orgId]/saml.tsx`.
 */

/** What each refusal means, in the words the person who hit it needs. Codes not
 *  listed here fall back to the generic message — the backend deliberately
 *  collapses anything it won't state publicly into `SAML_ERROR`. */
const ERROR_MESSAGES: Record<string, string> = {
  SAML_IDP_INITIATED:
    'Start single sign-on from Pipeline Builder rather than from your identity provider\'s app launcher. Sign-in that begins at the identity provider is not accepted.',
  SAML_REPLAYED_ASSERTION:
    'This single sign-on response has already been used. Start again from the sign-in page.',
  SAML_INVALID_ASSERTION:
    'Your identity provider\'s response could not be verified. If this keeps happening, ask an administrator to check the signing certificate in your SAML settings.',
  SAML_INVALID_STATE:
    'This sign-in request has expired or was already completed. Start again from the sign-in page.',
  SAML_NO_EMAIL:
    'Your identity provider did not send an email address. Ask an administrator to check the attribute mapping in your SAML settings.',
  SAML_EMAIL_DOMAIN_NOT_ALLOWED:
    'Your email domain is not permitted to sign in to this organization.',
  OIDC_EMAIL_DOMAIN_NOT_VERIFIED:
    'This organization has not verified ownership of your email domain, so it cannot sign you in with single sign-on.',
  SSO_SUPERADMIN_REFUSED:
    'Platform administrators cannot sign in through an organization\'s single sign-on.',
  JIT_SEAT_LIMIT:
    'Your organization has no seats left, so single sign-on could not add you to it. Ask an administrator to free a seat or raise the seat limit.',
  SAML_NOT_CONFIGURED: 'Single sign-on is not configured for this organization.',
  SAML_DISABLED: 'Single sign-on is not enabled for this organization.',
  SAML_NOT_ENTITLED: 'This organization is not entitled to single sign-on.',
  SAML_PROTOCOL_MISMATCH: 'This organization does not sign in with SAML.',
  SAML_INCOMPLETE_CONFIG:
    'The SAML configuration for this organization is incomplete. Ask an administrator to finish it.',
  SAML_ENCRYPTION_REQUIRED:
    'This organization requires encrypted assertions, but your identity provider sent an unencrypted one. Ask an administrator to check the SAML encryption settings.',
  SAML_UNEXPECTED_ENCRYPTION:
    'Your identity provider sent an encrypted assertion this organization is not set up to receive. Ask an administrator to check the SAML encryption settings.',
  SAML_INVALID_LOGOUT:
    'The single-logout message from your identity provider could not be verified. You may still be signed in — sign out from Pipeline Builder to be sure.',
};

const GENERIC_ERROR = 'Single sign-on could not be completed. Please try again, or contact an administrator if it keeps happening.';

export default function SamlLandingPage() {
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // A test-connection popup that has handed its state back to the settings page.
  const [testDone, setTestDone] = useState(false);
  // The handoff is single-use — guard against React 18 strict-mode double-invoke.
  const started = useRef(false);

  const complete = useCallback(async (orgId: string, handoff: string) => {
    try {
      await api.completeSamlLogin(orgId, handoff);
      await refreshUser();
      await router.replace('/dashboard');
    } catch (err) {
      setError(formatError(err, GENERIC_ERROR));
    }
  }, [refreshUser, router]);

  useEffect(() => {
    if (!router.isReady || started.current) return;
    started.current = true;

    const orgId = typeof router.query.orgId === 'string' ? router.query.orgId : '';
    const handoff = typeof router.query.handoff === 'string' ? router.query.handoff : '';
    const code = typeof router.query.error === 'string' ? router.query.error : '';
    const test = typeof router.query.test === 'string' ? router.query.test : '';

    if (test) {
      publishSsoTestResult({ type: SSO_TEST_CHANNEL, state: test });
      setTestDone(true);
      window.close();
      return;
    }
    if (code) {
      setError(ERROR_MESSAGES[code] ?? GENERIC_ERROR);
      return;
    }
    if (!orgId || !handoff) {
      // Somebody bookmarked or reloaded this page: there is no assertion behind
      // it and nothing to complete. Say so rather than spinning forever.
      setError('This single sign-on link has no pending sign-in. Start again from the sign-in page.');
      return;
    }
    void complete(orgId, handoff);
  }, [router.isReady, router.query, complete]);

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
            ) : testDone ? (
              <>
                <p className="font-bold">Test complete</p>
                <p className="text-sm text-fg-muted mt-1">The result is shown in the settings page. You can close this window.</p>
              </>
            ) : (
              <>
                <LoadingSpinner />
                <p className="font-bold mt-3">Completing single sign-on…</p>
                <p className="text-sm text-fg-muted mt-1">
                  Verifying the response from your identity provider.
                </p>
              </>
            )}
          </Card>
        </motion.div>
      </div>
    </>
  );
}
