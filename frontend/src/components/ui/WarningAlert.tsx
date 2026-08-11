// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';

interface WarningAlertProps {
  /** Warning content. Renders nothing when falsy, so callers can pass state directly. */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * The `.alert-warning` (amber) banner as a kit component — the counterpart to
 * `ErrorAlert`/`SuccessAlert` for the hand-rolled amber caution boxes scattered
 * across the app. Renders `null` when there's no message and adds `role="alert"`.
 */
export function WarningAlert({ message, onDismiss, className = '' }: WarningAlertProps) {
  if (!message) return null;
  return (
    <div className={['alert-warning', className].filter(Boolean).join(' ')} role="alert">
      <p>{message}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="action-link mt-2 underline">Dismiss</button>
      )}
    </div>
  );
}
