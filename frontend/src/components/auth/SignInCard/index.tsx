// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { KeyRound, LogIn, ShieldAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { providerLabel } from '@/lib/constants';
import { LostFactorHelp } from './LostFactorHelp';
import { MfaStep } from './MfaStep';
import { PasswordChangeStep } from './PasswordChangeStep';
import { PasswordStep } from './PasswordStep';
import { useSignInFlow } from './useSignInFlow';

/** The landing page's sign-in card: one step at a time, driven by {@link useSignInFlow}. */
export function SignInCard() {
  const flow = useSignInFlow();
  const {
    pwChange, mfaChallengeId, sessionExpired, error, mfaPolicyBlocked, ssoRequired,
    passkeySupported, providers, handlePasskeySignIn, isSubmitting, passkeyBusy, oauthBusy, startOAuth,
  } = flow;

  return (
    <Card className="p-5">
      <h2 className="font-bold mb-4">{pwChange ? 'Choose a new password' : mfaChallengeId ? 'Two-factor authentication' : 'Sign in'}</h2>

      {sessionExpired && !error && !mfaChallengeId && !pwChange && (
        <div className="alert-warning mb-3" role="status" aria-live="polite">
          <p>Your session expired. Sign in again and we&apos;ll take you back to where you were.</p>
        </div>
      )}
      <ErrorAlert message={error} className="mb-3" />

      {/* The org's MFA deadline has passed and this account has no factor to
          meet it, so there is nothing to sign in with. Say who can unblock
          them rather than repeat "enrol a factor" at somebody who cannot get
          far enough in to do it. */}
      {mfaPolicyBlocked && !mfaChallengeId && (
        <div className="alert-warning mb-3" role="status" aria-live="polite">
          <p className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{mfaPolicyBlocked}</span>
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-fg list-disc pl-8">
            <li>
              If you already have a passkey on this device, use{' '}
              <strong>Sign in with a passkey</strong> below — it satisfies the requirement
              on its own.
            </li>
            <li>
              If you saved recovery codes when you set up a passkey, sign in again — you
              will be asked for one.
            </li>
            <li>
              Otherwise two owners or admins of your organization can reset your two-factor
              authentication, which gives you a few days to sign in and enrol — see below.
            </li>
          </ul>
          <div className="mt-3">
            <LostFactorHelp />
          </div>
        </div>
      )}

      {pwChange
        ? <PasswordChangeStep flow={flow} minLength={pwChange.minLength} />
        : mfaChallengeId
          ? <MfaStep flow={flow} />
          : <PasswordStep flow={flow} />}

      {/* Passkeys and social sign-in are bypasses for a federated account — the
          backend refuses both with the same SSO_REQUIRED — so they go away with
          the password field. */}
      {!mfaChallengeId && !pwChange && !ssoRequired && (passkeySupported || providers.length > 0) && (
        <div className="mt-4">
          <div className="flex items-center gap-3 mb-3">
            <span className="flex-1 h-px bg-[var(--pb-border)]" />
            <span className="text-2xs uppercase tracking-wide text-fg-muted">or</span>
            <span className="flex-1 h-px bg-[var(--pb-border)]" />
          </div>
          <div className="space-y-2">
            {/* Explicit passkey sign-in. Shown even where autofill works — the
                dropdown is easy to miss, and one visible button is better than
                an invisible affordance. */}
            {passkeySupported && (
              <Button
                type="button"
                variant="secondary"
                fullWidth
                onClick={handlePasskeySignIn}
                disabled={isSubmitting || passkeyBusy || oauthBusy !== null}
                className="text-sm"
              >
                {passkeyBusy
                  ? <><LoadingSpinner size="sm" className="mr-2" /> Waiting for your passkey…</>
                  : <><KeyRound className="w-4 h-4 mr-1.5" /> Sign in with a passkey</>}
              </Button>
            )}
            {providers.map((p) => (
              <Button
                key={p}
                type="button"
                variant="secondary"
                fullWidth
                onClick={() => startOAuth(p)}
                disabled={isSubmitting || oauthBusy !== null}
                className="text-sm"
              >
                {oauthBusy === p
                  ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
                  : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in with {providerLabel(p)}</>}
              </Button>
            ))}
          </div>
        </div>
      )}

      {!mfaChallengeId && !pwChange && (
        <p className="text-xs text-fg-muted mt-4 text-center">
          New here?{' '}
          <Link href="/auth/register" className="text-brand hover:underline">
            Create account
          </Link>
        </p>
      )}
    </Card>
  );
}
