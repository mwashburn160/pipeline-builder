// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from 'react';
import { formatError } from '@/lib/constants';

export interface FormState {
  loading: boolean;
  error: string | null;
  success: string | null;
  setError: (msg: string | null) => void;
  setSuccess: (msg: string | null) => void;
  reset: () => void;
  /** Run an async action with automatic loading/error management. */
  run: <T>(fn: () => Promise<T>, opts?: { successMessage?: string }) => Promise<T | null>;
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

  const run = useCallback(async <T,>(fn: () => Promise<T>, opts?: { successMessage?: string }): Promise<T | null> => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await fn();
      setSuccess(opts?.successMessage ?? null);
      return result;
    } catch (err) {
      setError(formatError(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, success, setError, setSuccess, reset, run };
}
