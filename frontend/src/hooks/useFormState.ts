// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from 'react';
import { continueAfterStepUp } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';

export interface RunOptions<T> {
  /** Shown in `success` once the action lands (including after a step-up replay). */
  successMessage?: string;
  /**
   * The "it worked" side effects — close the modal, refresh the list, toast.
   *
   * Put them HERE rather than in an `if (result !== null)` block after the
   * `await`: when the route step-up-gates the write, `run` resolves `null`
   * immediately (the global dialog has taken the refusal over) and the replay
   * lands minutes later, so a post-`await` block would never run for it. This
   * callback runs on both paths, with the same result either way.
   */
  onSuccess?: (result: T) => void;
}

export interface FormState {
  loading: boolean;
  error: string | null;
  success: string | null;
  setError: (msg: string | null) => void;
  setSuccess: (msg: string | null) => void;
  reset: () => void;
  /**
   * Run an async action with automatic loading/error management.
   *
   * Resolves with the action's result, or `null` when it failed — and also when
   * it was refused for step-up and the global dialog took the refusal over, in
   * which case there is no result yet. Use `opts.onSuccess` for anything that
   * must happen when the write actually lands.
   */
  run: <T>(fn: () => Promise<T>, opts?: RunOptions<T>) => Promise<T | null>;
}

/**
 * Manages the loading/error/success triplet for form submissions and async actions.
 * Eliminates the need for separate useState calls for each form section.
 *
 * @example
 * ```tsx
 * const profile = useFormState();
 * const password = useFormState();
 *
 * const handleProfile = () => profile.run(
 *   () => api.updateProfile(data),
 *   { successMessage: 'Profile updated!' }
 * );
 * ```
 */
export function useFormState(): FormState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setSuccess(null);
  }, []);

  const settle = useCallback(<T,>(result: T, opts?: RunOptions<T>) => {
    setSuccess(opts?.successMessage ?? null);
    opts?.onSuccess?.(result);
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>, opts?: RunOptions<T>): Promise<T | null> => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      // Refused for step-up and taken over by the global dialog: that dialog
      // reports the outcome, so an error here would sit under it contradicting
      // it. Once the person confirms and the replay lands, finish exactly as a
      // direct success does; if they dismiss it, the form is still on screen,
      // so say the write did not happen rather than leave it looking inert.
      const claimed = continueAfterStepUp<T>(
        err,
        (replayed) => settle(replayed, opts),
        (reason) => setError(formatError(reason)),
      );
      if (!claimed) setError(formatError(err));
      return null;
    } finally {
      setLoading(false);
    }
    // Outside the `try` on purpose: a throw from the caller's own side effects
    // is a render bug, not a failed write, and must not be reported as one.
    settle(result, opts);
    return result;
  }, [settle]);

  return { loading, error, success, setError, setSuccess, reset, run };
}
