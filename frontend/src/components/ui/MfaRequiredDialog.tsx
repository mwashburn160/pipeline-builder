// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { KeyRound, ShieldAlert, Smartphone } from 'lucide-react';
import api from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { Button } from './Button';
import { Modal } from './Modal';
import type { AuthFactors } from '@/types';

interface Props {
  /** `MFA_REQUIRED` (no second factor on this session) or `REAUTH_REQUIRED`
   *  (there is one, but the sign-in is older than the route allows). */
  code: string;
  /** The server's own wording, which is more specific than anything derivable here. */
  message: string;
  onClose: () => void;
}

const ENROL_HREF = '/dashboard/settings?tab=security#passkeys';

/**
 * What the app shows when a route refuses the SESSION for not being MFA-grade
 * (#8) — the counterpart to `StepUpModal`, for the refusal that a step-up
 * cannot fix.
 *
 * The distinction matters to the person in front of the screen:
 *
 *   - if they have NO factor, the only way forward is to enrol one, and then
 *     sign in again — so the primary action is Set up, not Sign in;
 *   - if they HAVE one (or the refusal was `REAUTH_REQUIRED`), enrolment would
 *     be busywork: they just need a fresh sign-in that presents it, so the
 *     primary action is Sign out and sign in again.
 *
 * It never signs anyone out on its own. The session is valid for everything
 * except the route that refused, and the person may well want to finish
 * something else first — or, in the enrolment case, needs this very session to
 * register the factor.
 */
export function MfaRequiredDialog({ code, message, onClose }: Props) {
  const { logout } = useAuth();
  const router = useRouter();
  const [factors, setFactors] = useState<AuthFactors | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getProfile();
        if (!cancelled) setFactors(res.data?.user?.authFactors ?? null);
      } catch {
        // Fail soft: with no answer, offer BOTH routes rather than guessing.
        if (!cancelled) setFactors(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasFactor = (factors?.passkeyCount ?? 0) > 0 || factors?.hasTotp === true;
  const stale = code === 'REAUTH_REQUIRED';
  const needsEnrolment = !stale && factors !== null && !hasFactor;

  return (
    <Modal
      title={stale ? 'Please sign in again' : 'Two-factor authentication required'}
      titleIcon={<ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" />}
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>

        {stale ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            This action needs a recent sign-in. Your session is fine for everything else —
            sign in again and retry.
          </p>
        ) : needsEnrolment ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            This account has no second factor yet. Add a passkey (a fingerprint, face or
            security key) or an authenticator app, then sign in again — signing in with the
            new factor is what makes the session strong enough.
          </p>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            You signed in with a single factor this time. Sign in again with your passkey or
            authenticator code and retry — refreshing the session cannot raise it.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Not now
          </Button>
          {!stale && (
            <Button
              type="button"
              variant={needsEnrolment ? 'primary' : 'secondary'}
              className="inline-flex items-center gap-2"
              onClick={() => { onClose(); void router.push(ENROL_HREF); }}
            >
              {(factors?.hasTotp && !factors.passkeyCount) ? <Smartphone className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
              {needsEnrolment ? 'Set up two-factor' : 'Manage factors'}
            </Button>
          )}
          <Button
            type="button"
            variant={needsEnrolment ? 'secondary' : 'primary'}
            onClick={() => { onClose(); void logout(); }}
          >
            Sign in again
          </Button>
        </div>
      </div>
    </Modal>
  );
}
