// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { motion } from 'framer-motion';
import { ArrowLeft, CheckCircle, MonitorSmartphone, ShieldAlert, Terminal, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useAuth } from '@/hooks/useAuth';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { SESSIONS_HREF } from '@/lib/security-links';
import { rememberReturnPath } from '@/lib/return-to';
import { ApiError } from '@/lib/api/errors';
import type { DeviceAuthorizationRequest } from '@/lib/api/domains/auth';

/** The page's terminal states, all of which end the flow. */
type Outcome = 'approved' | 'denied';

/**
 * Device authorization approval page — the browser half of `pipeline-manager
 * auth login` (RFC 8628).
 *
 * The CLI prints a short code and this URL; the person confirms HERE, in a
 * normal signed-in session, which is what brings SSO, step-up and (later) MFA
 * to bear on a terminal sign-in. Approving is step-up gated, like signing
 * another device out from the sessions page, because the outcome is the same
 * kind of thing: a new device holding a session.
 *
 * The device code never reaches this page — only the short user code and a
 * description of the device, so the person can tell "the terminal I just typed
 * in" from someone else's code they have been talked into approving.
 */
export default function DeviceApprovalPage() {
  const router = useRouter();
  const { isAuthenticated, isInitialized, isLoading } = useAuth();

  const [code, setCode] = useState('');
  const [typed, setTyped] = useState('');
  const [request, setRequest] = useState<DeviceAuthorizationRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stepUp, setStepUp] = useState(false);

  const authReady = isInitialized && !isLoading;

  // The CLI opens `verification_uri_complete`, which carries the code.
  useEffect(() => {
    if (!router.isReady) return;
    const fromUrl = typeof router.query.user_code === 'string' ? router.query.user_code : '';
    if (fromUrl) setCode(fromUrl);
  }, [router.isReady, router.query.user_code]);

  // Send a signed-out visitor to sign in, then straight back to this code.
  useEffect(() => {
    if (!authReady || isAuthenticated) return;
    rememberReturnPath(router.asPath);
  }, [authReady, isAuthenticated, router.asPath]);

  const load = useCallback(async (userCode: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDeviceAuthorization(userCode);
      if (res.success && res.data) {
        setRequest(res.data.request);
      } else {
        setRequest(null);
        setError(res.message || 'That code could not be checked. Try again.');
      }
    } catch (err) {
      setRequest(null);
      // The backend distinguishes these deliberately: an expired code means
      // "start again on your device", a bad one means "check what you typed".
      const status = err instanceof ApiError ? err.statusCode : 0;
      if (status === 410) setError('That code has expired. Run the sign-in again on your device to get a new one.');
      else if (status === 409) setError('That code has already been used.');
      else if (status === 404) setError('That code was not recognised. Check it and try again.');
      else setError(formatError(err, 'That code could not be checked. Try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authReady || !isAuthenticated || !code) return;
    void load(code);
  }, [authReady, isAuthenticated, code, load]);

  const decide = useCallback(async (decision: Outcome, stepUpToken?: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = decision === 'approved'
        ? await api.approveDeviceAuthorization(code, stepUpToken)
        : await api.denyDeviceAuthorization(code);
      if (res.success) {
        setOutcome(decision);
      } else {
        setError(res.message || 'That did not go through. Try again.');
      }
    } catch (err) {
      setError(formatError(err, 'That did not go through. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }, [code]);

  const shell = (children: React.ReactNode) => (
    <>
      <Head><title>Approve device - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-md mx-auto mb-6">
          <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Dashboard
          </Link>
        </div>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-md mx-auto">
          <Card className="p-8">{children}</Card>
        </motion.div>
      </div>
    </>
  );

  if (!authReady) {
    return shell(
      <div className="text-center" role="status" aria-live="polite">
        <LoadingSpinner size="md" className="mx-auto mb-3" />
        <p className="font-bold">Checking your session…</p>
      </div>,
    );
  }

  if (!isAuthenticated) {
    return shell(
      <div className="text-center">
        <Terminal className="w-10 h-10 text-fg-muted mx-auto mb-3" />
        <p className="font-bold">Sign in to approve this device</p>
        <p className="text-sm text-fg-muted mt-1">
          Approving a terminal sign-in needs your account. You will come straight back here.
        </p>
        <Button className="mt-4" fullWidth onClick={() => router.push('/')}>Sign in</Button>
      </div>,
    );
  }

  if (outcome === 'approved') {
    return shell(
      <div className="text-center" role="status" aria-live="polite">
        <CheckCircle className="w-10 h-10 text-success mx-auto mb-3" />
        <p className="font-bold">Device approved</p>
        <p className="text-sm text-fg-muted mt-1">
          Return to your terminal — it finishes signing in within a few seconds. The session shows up under
          Security → Sessions, where you can sign it out again.
        </p>
        {/* The sessions list itself. */}
        <Link href={SESSIONS_HREF} className="btn btn-secondary btn-full text-sm mt-4">Sessions and devices</Link>
      </div>,
    );
  }

  if (outcome === 'denied') {
    return shell(
      <div className="text-center" role="status" aria-live="polite">
        <XCircle className="w-10 h-10 text-danger mx-auto mb-3" />
        <p className="font-bold">Request denied</p>
        <p className="text-sm text-fg-muted mt-1">
          Nothing was signed in. If you did not start this, nobody got access — and you did the right thing.
        </p>
      </div>,
    );
  }

  // No code in the URL (someone opened the bare verification URI), or the one we
  // had did not resolve: ask for it.
  if (!request) {
    return shell(
      <>
        <div className="text-center">
          <MonitorSmartphone className="w-10 h-10 text-fg-muted mx-auto mb-3" />
          <p className="font-bold">Enter the code from your device</p>
          <p className="text-sm text-fg-muted mt-1">
            Your terminal shows an eight-character code while it waits.
          </p>
        </div>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const next = typed.trim();
            if (!next) return;
            setCode(next);
            void load(next);
          }}
        >
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            placeholder="BCDF-GHJK"
            aria-label="Device code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="w-full text-center font-mono tracking-[0.3em]"
            disabled={loading}
          />
          <ErrorAlert message={error} />
          <Button type="submit" fullWidth disabled={loading || typed.trim().length === 0}>
            {loading ? <LoadingSpinner size="sm" /> : 'Continue'}
          </Button>
        </form>
      </>
    );
  }

  return (
    <>
      {shell(
        <>
          <div className="text-center">
            <ShieldAlert className="w-10 h-10 text-warning mx-auto mb-3" />
            <p className="font-bold">Approve this sign-in?</p>
            <p className="text-sm text-fg-muted mt-1">
              A device is asking to sign in as you. Approve it only if you just started this yourself.
            </p>
          </div>

          <dl className="mt-5 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-fg-muted">Code</dt>
              <dd className="font-mono tracking-widest">{request.userCode}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-muted">Device</dt>
              <dd className="font-medium text-right">{request.client ?? 'Unknown client'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-muted">From IP</dt>
              <dd className="font-mono text-xs">{request.ip ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-muted">Requested</dt>
              <dd><RelativeTime value={request.requestedAt} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-fg-muted">Expires</dt>
              <dd><RelativeTime value={request.expiresAt} /></dd>
            </div>
          </dl>

          <p className="mt-4 text-xs text-fg-muted">
            {request.stepUpRequested
              ? 'Approving gives that device a session in your current organization AND lets it create one access key right away.'
              : 'Approving gives that device a session in your current organization. You can sign it out again at any time from Sessions and devices.'}
          </p>

          <ErrorAlert message={error} className="mt-3" />

          <div className="mt-5 flex gap-2">
            <Button variant="secondary" fullWidth disabled={submitting} onClick={() => void decide('denied')}>
              Deny
            </Button>
            <Button fullWidth disabled={submitting} onClick={() => setStepUp(true)}>
              {submitting ? <LoadingSpinner size="sm" /> : 'Approve'}
            </Button>
          </div>
        </>,
      )}

      {stepUp && (
        <StepUpModal
          action={`sign in ${request.client ?? 'that device'} as you`}
          onConfirmed={(token) => decide('approved', token)}
          onClose={() => setStepUp(false)}
        />
      )}
    </>
  );
}
