// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { useMutation } from '@/hooks/useMutation';

/** The platform's one answer to a reset request — shown whatever happened. */
const RESET_REQUESTED_MESSAGE = 'If an account with that email can reset its password, a reset link is on its way.';

/**
 * "Forgot password?" — asks for an email and posts
 * `POST /auth/password/reset-request` (public).
 *
 * The route ALWAYS answers 200 with the same sentence, so it cannot tell anyone
 * whether an address has an account; this page says that sentence after any
 * accepted request rather than "sent!". The only refusals worth showing are a
 * 429 (3 per address / 20 per IP in 15 minutes) and an unreachable server.
 * The emailed link lands on `/auth/reset-password?token=…`.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const request = useMutation({
    fn: (address: string) => api.requestPasswordReset(address),
    formatError: (err) => (err instanceof ApiError && err.statusCode === 429
      ? 'Too many reset requests. Wait a few minutes, then try again.'
      : formatError(err, 'Could not request a reset link')),
    onSuccess: () => setSent(true),
  });
  const submitting = request.pending;
  const error = request.error;

  // The sign-in card passes what was typed there, when it looked like an email.
  useEffect(() => {
    if (!router.isReady) return;
    const prefill = typeof router.query.email === 'string' ? router.query.email : '';
    if (prefill) setEmail((prev) => prev || prefill);
  }, [router.isReady, router.query.email]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    await request.run(trimmed);
  };

  return (
    <>
      <Head><title>Reset your password - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
          </Link>
        </div>
        <div className="max-w-sm mx-auto">
          <Card className="p-8">
            {sent ? (
              <div className="text-center" role="status" aria-live="polite">
                <MailCheck className="w-10 h-10 text-success mx-auto mb-3" />
                <p className="font-bold">Check your email</p>
                <p className="text-sm text-fg-muted mt-1">{RESET_REQUESTED_MESSAGE}</p>
                <p className="text-xs text-fg-muted mt-3">
                  The link works once and expires soon. Accounts that sign in only with Google, GitHub or
                  single sign-on have no password to reset — sign in with that provider instead.
                </p>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <h1 className="font-bold text-lg">Reset your password</h1>
                <p className="text-sm text-fg-muted">Enter your account&apos;s email and we&apos;ll send a link to choose a new password.</p>
                <ErrorAlert message={error} />
                <Input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="Email"
                  aria-label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                />
                <Button type="submit" fullWidth disabled={submitting || !email.trim()} className="text-sm">
                  {submitting ? <><LoadingSpinner size="sm" className="mr-2" /> Sending…</> : 'Send reset link'}
                </Button>
              </form>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
