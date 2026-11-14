// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { ArrowLeft, CheckCircle, KeyRound, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Input } from '@/components/ui/Input';
import { LinkButton } from '@/components/ui/LinkButton';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

/** The emailed token: 32 random bytes, hex. Anything else can only be refused. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
/** The platform's default minimum (PASSWORD_MIN_LENGTH); an org may require more. */
const PLATFORM_MIN_LENGTH = 8;

type Outcome =
  | { kind: 'form' }
  | { kind: 'done'; accessKeysRevoked: number }
  | { kind: 'invalid' }
  | { kind: 'sso' };

/**
 * Where the password-reset email lands (`/auth/reset-password?token=…`).
 * Posts `POST /auth/password/reset` `{ token, newPassword }` (public).
 *
 * - 200 → done; every session was ended and the account's access keys revoked
 *   (`accessKeysRevoked`), so the person signs in fresh.
 * - 400 `PASSWORD_RESET_TOKEN_INVALID` → the link is dead (expired, used, or
 *   never issued): offer a new one.
 * - 403 `SSO_REQUIRED` → the account's org requires single sign-on; a password
 *   would not sign them in anyway.
 * - Any other 400 (`PASSWORD_UNCHANGED`, the org's longer minimum, a breached
 *   password) → the link is still good: show the reason and keep the form.
 *
 * `GET /user/password-policy` needs a session, so the platform rules are stated
 * here and the org's stricter minimum, if any, comes back as a refusal.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'form' });

  const tokenLooksValid = TOKEN_SHAPE.test(token);
  const view: Outcome = router.isReady && !tokenLooksValid && outcome.kind === 'form' ? { kind: 'invalid' } : outcome;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < PLATFORM_MIN_LENGTH) { setError(`Use at least ${PLATFORM_MIN_LENGTH} characters.`); return; }
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.resetPassword(token, password);
      setOutcome({ kind: 'done', accessKeysRevoked: res.data?.accessKeysRevoked ?? 0 });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSWORD_RESET_TOKEN_INVALID') setOutcome({ kind: 'invalid' });
      else if (err instanceof ApiError && err.code === 'SSO_REQUIRED') setOutcome({ kind: 'sso' });
      else setError(formatError(err, 'Could not reset your password'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Head>
        <title>Choose a new password - Pipeline Builder</title>
        {/* The token is in this page's URL — never hand it to another site. */}
        <meta name="referrer" content="no-referrer" />
      </Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
          </Link>
        </div>
        <div className="max-w-sm mx-auto">
          <Card className="p-8">
            {!router.isReady ? (
              <LoadingSpinner size="md" className="mx-auto" />
            ) : view.kind === 'done' ? (
              <div className="text-center" role="status" aria-live="polite">
                <CheckCircle className="w-10 h-10 text-success mx-auto mb-3" />
                <p className="font-bold">Password reset</p>
                <p className="text-sm text-fg-muted mt-1">Sign in with your new password.</p>
                <p className="text-xs text-fg-muted mt-2">
                  You were signed out everywhere
                  {view.accessKeysRevoked > 0
                    ? ` and ${view.accessKeysRevoked} access key${view.accessKeysRevoked === 1 ? ' was' : 's were'} revoked — create new ones for your CLI and automation.`
                    : '.'}
                </p>
                <LinkButton href="/" fullWidth className="text-sm mt-4">Sign in</LinkButton>
              </div>
            ) : view.kind === 'invalid' ? (
              <div className="text-center" role="alert">
                <XCircle className="w-10 h-10 text-danger mx-auto mb-3" />
                <p className="font-bold">This reset link is invalid or has expired</p>
                <p className="text-sm text-fg-muted mt-1">Each link works once and only for a short time.</p>
                <LinkButton href="/auth/forgot-password" variant="secondary" fullWidth className="text-sm mt-4">
                  Request a new link
                </LinkButton>
              </div>
            ) : view.kind === 'sso' ? (
              <div className="text-center" role="alert">
                <KeyRound className="w-10 h-10 text-fg-muted mx-auto mb-3" />
                <p className="font-bold">Your organization requires SSO</p>
                <p className="text-sm text-fg-muted mt-1">
                  Sign in with your organization&apos;s identity provider instead — enter your email on the sign-in page and
                  choose single sign-on.
                </p>
                <LinkButton href="/" fullWidth className="text-sm mt-4">Go to sign in</LinkButton>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <h1 className="font-bold text-lg">Choose a new password</h1>
                <p className="text-xs text-fg-muted">
                  At least {PLATFORM_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter and a digit. Your
                  organization may require a longer one. Resetting signs you out everywhere and revokes your access keys.
                </p>
                <ErrorAlert message={error} />
                <Input
                  id="reset-new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="New password"
                  aria-label="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
                <Input
                  id="reset-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="Confirm new password"
                  aria-label="Confirm new password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                />
                <Button type="submit" fullWidth disabled={submitting || !password || !confirm} className="text-sm">
                  {submitting ? <><LoadingSpinner size="sm" className="mr-2" /> Resetting…</> : 'Reset password'}
                </Button>
              </form>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
