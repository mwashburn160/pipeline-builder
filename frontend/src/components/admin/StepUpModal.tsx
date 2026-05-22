// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { X, ShieldAlert } from 'lucide-react';
import api from '@/lib/api';
import { LoadingSpinner } from '@/components/ui/Loading';

interface Props {
  /** Short description of the action being gated, shown to the user. */
  action: string;
  /** Called with the short-lived step-up token after password verifies.
   *  The caller MUST pass this token to the subsequent destructive API
   *  call as the second argument; api methods that require step-up
   *  forward it via the `X-Step-Up-Token` header. */
  onConfirmed: (stepUpToken: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Password re-prompt before destructive sysadmin actions (grant/revoke
 * platform-admin, KMS rotation, namespace YAML download, org delete,
 * bulk-delete users, ownership transfer).
 *
 * Calls POST /api/auth/step-up; backend returns a 60s-TTL JWT bound to
 * the user's sub. The token is passed to `onConfirmed` and forwarded by
 * the caller's API call; backend `requireStepUp` middleware enforces.
 */
export function StepUpModal({ action, onConfirmed, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!password) {
      setError('Password is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.stepUpVerify(password);
      if (res.success && res.data?.stepUpToken) {
        await onConfirmed(res.data.stepUpToken);
        onClose();
      } else {
        setError(res.message || 'Verification failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [password, onConfirmed, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-md">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            <h2 className="text-sm font-semibold">Confirm with password</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 px-4 py-4">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            About to: <strong>{action}</strong>
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Re-enter your password to confirm. This protects against accidental
            destructive actions on a left-open session.
          </p>

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            className="filter-input w-full"
            disabled={submitting}
          />

          {error && (
            <div className="alert-error">
              <p>{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary inline-flex items-center gap-2"
              disabled={submitting || !password}
            >
              {submitting && <LoadingSpinner size="sm" />}
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
