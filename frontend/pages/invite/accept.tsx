// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Mail, CheckCircle, XCircle, ArrowLeft, UserPlus } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';

interface InvitePreview {
  email: string;
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  isValid: boolean;
  canAcceptViaEmail: boolean;
  canAcceptViaGoogle: boolean;
}

/**
 * Invitation accept page.
 *
 * Invitation emails link here (`/invite/accept?token=…`, set in the platform
 * invite email template). Previously the loop dead-ended: an invitee had no UI
 * to accept. This page previews the invite (public `GET /invitation/:token`),
 * then:
 *   - logged in  → accepts directly (`POST /invitation/accept`, body `{ token }`)
 *   - logged out → register-and-accept: create the account with the invited
 *     email (locked), log in, then accept. The backend matches the accepting
 *     user's email against the invite, so the email must be the invited one.
 *
 * OAuth-only invites can't complete here (the accept-oauth flow needs the full
 * provider code/state exchange); we surface a message pointing at Google sign-in.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const { user, isInitialized, login, register, refreshUser } = useAuth();

  const [token, setToken] = useState('');
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Register-and-accept form (logged-out path).
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    const t = typeof router.query.token === 'string' ? router.query.token : '';
    if (!t) {
      setLoading(false);
      setLoadError('No invitation token was provided in the link.');
      return;
    }
    setToken(t);
    api.getInvitationByToken(t)
      .then((res) => {
        if (res.success && res.data?.invitation) {
          setInvite(res.data.invitation as InvitePreview);
        } else {
          setLoadError(res.message || 'This invitation could not be found.');
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'This invitation could not be found.'))
      .finally(() => setLoading(false));
  }, [router.isReady, router.query.token]);

  const finish = async () => {
    setDone(true);
    await refreshUser();
    setTimeout(() => router.push('/dashboard'), 1200);
  };

  // Logged-in: accept directly.
  const handleAcceptLoggedIn = async () => {
    setSubmitting(true);
    setActionError(null);
    try {
      const res = await api.acceptInvitation(token);
      if (!res.success) throw new Error(res.message || 'Failed to accept invitation');
      await finish();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to accept invitation');
    } finally {
      setSubmitting(false);
    }
  };

  // Logged-out: register with the invited email, log in, then accept.
  const handleRegisterAndAccept = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!invite) return;
    setActionError(null);
    if (username.trim().length < 3) { setActionError('Username must be at least 3 characters'); return; }
    if (password.length < 8) { setActionError('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setActionError('Passwords do not match'); return; }

    setSubmitting(true);
    try {
      // No organizationName — accepting the invite is what places the user in an
      // org; creating a second org here would be wrong.
      await register(username.trim(), invite.email, password);
      await login(invite.email, password);
      const res = await api.acceptInvitation(token);
      if (!res.success) throw new Error(res.message || 'Failed to accept invitation');
      await finish();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create account and accept');
    } finally {
      setSubmitting(false);
    }
  };

  const inviteUnusable = invite && (!invite.isValid || invite.status !== 'pending');

  return (
    <>
      <Head><title>Accept Invitation - Pipeline Builder</title></Head>
      <div className="min-h-screen px-6 py-10">
        <div className="max-w-sm mx-auto mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-[var(--pb-text-muted)] hover:text-[var(--pb-text)] transition-colors">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-sm mx-auto">
          <div className="flex items-center justify-center mb-4">
            <Mail className="w-7 h-7 text-[var(--pb-brand)]" />
          </div>
          <h1 className="text-xl font-bold text-center mb-1">You&apos;re invited</h1>

          <div className="card p-5 mt-4">
            {(loading || !isInitialized) && (
              <div className="py-6 text-center" role="status" aria-live="polite">
                <LoadingSpinner size="md" className="mx-auto mb-2" />
                <p className="text-sm text-[var(--pb-text-muted)]">Loading invitation…</p>
              </div>
            )}

            {!loading && loadError && (
              <div className="py-4 text-center">
                <XCircle className="w-9 h-9 text-[var(--pb-danger)] mx-auto mb-2" />
                <p className="text-sm text-[var(--pb-text-muted)]">{loadError}</p>
              </div>
            )}

            {!loading && done && (
              <div className="py-4 text-center" role="status" aria-live="polite">
                <CheckCircle className="w-9 h-9 text-[var(--pb-success)] mx-auto mb-2" />
                <p className="font-bold">Invitation accepted!</p>
                <p className="text-sm text-[var(--pb-text-muted)] mt-1">Redirecting to your dashboard…</p>
              </div>
            )}

            {!loading && !loadError && !done && invite && isInitialized && (
              <>
                <p className="text-sm text-[var(--pb-text-muted)] mb-4">
                  Invitation for <strong className="text-[var(--pb-text)]">{invite.email}</strong> to
                  join as <strong className="text-[var(--pb-text)]">{invite.role}</strong>.
                </p>

                {actionError && <div className="alert-error text-sm mb-3">{actionError}</div>}

                {inviteUnusable ? (
                  <div className="text-center py-2">
                    <XCircle className="w-8 h-8 text-[var(--pb-danger)] mx-auto mb-2" />
                    <p className="text-sm text-[var(--pb-text-muted)]">
                      This invitation is {invite.status === 'pending' ? 'no longer valid' : invite.status} and can&apos;t be accepted.
                    </p>
                  </div>
                ) : user ? (
                  // Logged in.
                  <>
                    <p className="text-xs text-[var(--pb-text-muted)] mb-3">
                      Signed in as <strong>{user.email}</strong>.
                      {user.email.toLowerCase() !== invite.email.toLowerCase() && (
                        <> This invite was sent to a different email — accepting may be rejected.</>
                      )}
                    </p>
                    <button
                      onClick={handleAcceptLoggedIn}
                      disabled={submitting}
                      className="btn btn-primary btn-full text-sm"
                    >
                      {submitting
                        ? <><LoadingSpinner size="sm" className="mr-2" /> Accepting…</>
                        : <><CheckCircle className="w-4 h-4 mr-1.5" /> Accept invitation</>}
                    </button>
                  </>
                ) : invite.canAcceptViaEmail ? (
                  // Logged out — register-and-accept.
                  <form onSubmit={handleRegisterAndAccept} className="space-y-3">
                    <p className="text-xs text-[var(--pb-text-muted)]">
                      Create your account to accept. Already have one?{' '}
                      <Link href="/" className="text-[var(--pb-brand)] hover:underline">Sign in</Link> first, then reopen this link.
                    </p>
                    <input
                      type="email"
                      className="input opacity-70"
                      value={invite.email}
                      disabled
                      aria-label="Invited email"
                    />
                    <input
                      type="text"
                      autoComplete="username"
                      required
                      className="input"
                      placeholder="Username"
                      aria-label="Username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      disabled={submitting}
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      className="input"
                      placeholder="Password (min 8 chars)"
                      aria-label="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={submitting}
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      className="input"
                      placeholder="Confirm password"
                      aria-label="Confirm password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={submitting}
                    />
                    <button type="submit" disabled={submitting} className="btn btn-primary btn-full text-sm">
                      {submitting
                        ? <><LoadingSpinner size="sm" className="mr-2" /> Creating account…</>
                        : <><UserPlus className="w-4 h-4 mr-1.5" /> Create account &amp; accept</>}
                    </button>
                  </form>
                ) : (
                  // OAuth-only invite, logged out.
                  <div className="text-center py-2">
                    <p className="text-sm text-[var(--pb-text-muted)]">
                      This invitation must be accepted by signing in with
                      {invite.canAcceptViaGoogle ? ' Google' : ' an approved sign-in provider'}.
                      Sign in first, then reopen this link.
                    </p>
                    <Link href="/" className="btn btn-secondary btn-full text-sm mt-3">Go to sign in</Link>
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </div>
    </>
  );
}
