// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { CheckCircle, XCircle, ArrowLeft } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';

/**
 * Email-verification landing page.
 *
 * The verification email links here (`/auth/verify-email?token=…`, set in
 * platform `sendVerificationEmail`). Reads the token from the query, calls
 * `POST /auth/verify-email` (public), and reports success/failure. No auth
 * required — the token itself proves ownership.
 */
export default function VerifyEmailPage() {
  const router = useRouter();
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState<string>('');
  // Guard against the effect running twice (React 18 strict-mode / query
  // hydration) verifying the same single-use token twice.
  const started = useRef(false);

  useEffect(() => {
    if (!router.isReady || started.current) return;
    const token = typeof router.query.token === 'string' ? router.query.token : '';
    if (!token) {
      setStatus('error');
      setMessage('No verification token was provided in the link.');
      return;
    }
    started.current = true;
    api.verifyEmail(token)
      .then((res) => {
        if (res.success) {
          setStatus('success');
          setMessage(res.message || 'Your email has been verified.');
        } else {
          setStatus('error');
          setMessage(res.message || 'This verification link is invalid or has expired.');
        }
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'This verification link is invalid or has expired.');
      });
  }, [router.isReady, router.query.token]);

  return (
    <>
      <Head><title>Verify Email - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <div className="card p-8 text-center" role="status" aria-live="polite">
            {status === 'pending' && (
              <>
                <LoadingSpinner size="md" className="mx-auto mb-3" />
                <p className="font-bold">Verifying your email…</p>
              </>
            )}
            {status === 'success' && (
              <>
                <CheckCircle className="w-10 h-10 text-[var(--pb-success)] mx-auto mb-3" />
                <p className="font-bold">Email verified</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">{message}</p>
                <Link href="/dashboard" className="btn btn-primary btn-full text-sm mt-4">
                  Go to dashboard
                </Link>
              </>
            )}
            {status === 'error' && (
              <>
                <XCircle className="w-10 h-10 text-[var(--pb-danger)] mx-auto mb-3" />
                <p className="font-bold">Verification failed</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">{message}</p>
                <Link href="/dashboard/settings" className="btn btn-secondary btn-full text-sm mt-4">
                  Resend from settings
                </Link>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </>
  );
}
