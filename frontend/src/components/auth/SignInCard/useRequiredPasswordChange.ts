// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { useAuth, type LoginResult } from '@/hooks/useAuth';
import { useMutation } from '@/hooks/useMutation';
import { formatError } from '@/lib/constants';
import { rateLimitedMessage } from '@/lib/rate-limit-message';

/**
 * A sign-in failure as the person should read it. A rate-limited one says WHEN
 * to try again ("Try again in 12 minutes") rather than "later": every failed
 * retry on the sign-in bucket is counted, so retrying blind extends the wait.
 */
export function signInError(err: unknown, fallback: string): string {
  return rateLimitedMessage(err) ?? formatError(err, fallback);
}

interface Options {
  /** Where the step reports its validation / server errors. */
  setError: (message: string | null) => void;
  /** Extra work when the person abandons the step (e.g. leave the page). */
  onCancel?: () => void;
}

/**
 * The "your password is below the org policy — choose a new one" step, shared
 * by every surface that can end a sign-in leg with `password_change_required`:
 * the sign-in card (after the password or the second factor) and the OAuth
 * callback page (after the second factor). Feed each {@link LoginResult} to
 * `takeLoginResult`; when it owes a new password the step opens and it returns
 * true, so the caller can drop whatever step it was showing.
 */
export function useRequiredPasswordChange({ setError, onCancel }: Options) {
  const { completeRequiredPasswordChange } = useAuth();
  const [pwChange, setPwChange] = useState<{ challengeId: string; minLength: number } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const change = useMutation({
    fn: (challengeId: string, password: string) => completeRequiredPasswordChange(challengeId, password),
    formatError: (err) => signInError(err, 'Could not change your password'),
    onError: (err, message) => {
      // A dead handle can't be retried — back to the previous step.
      if ((err as { code?: string } | null)?.code === 'PASSWORD_CHANGE_CHALLENGE_INVALID') setPwChange(null);
      setError(message);
    },
  });
  const pwChangeBusy = change.pending;

  const takeLoginResult = useCallback((result: LoginResult | null | undefined): boolean => {
    if (result?.status !== 'password_change_required') return false;
    setNewPassword('');
    setConfirmNewPassword('');
    setPwChange({ challengeId: result.challengeId, minLength: result.minLength });
    return true;
  }, []);

  /** Last leg of a sign-in whose password is below the org policy: a new one. */
  const handlePasswordChangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!pwChange) return;
    if (newPassword.length < pwChange.minLength) {
      setError(`Your organization requires at least ${pwChange.minLength} characters`);
      return;
    }
    if (newPassword !== confirmNewPassword) { setError('Passwords do not match'); return; }
    await change.run(pwChange.challengeId, newPassword);
  };

  const cancelPasswordChange = () => {
    setPwChange(null);
    setNewPassword('');
    setConfirmNewPassword('');
    setError(null);
    onCancel?.();
  };

  return {
    pwChange, takeLoginResult,
    newPassword, setNewPassword, confirmNewPassword, setConfirmNewPassword, pwChangeBusy,
    handlePasswordChangeSubmit, cancelPasswordChange,
  };
}

export type RequiredPasswordChange = ReturnType<typeof useRequiredPasswordChange>;
