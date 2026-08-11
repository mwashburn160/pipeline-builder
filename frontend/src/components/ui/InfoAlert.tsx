// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';

interface InfoAlertProps {
  /** Info content. Renders nothing when falsy, so callers can pass state directly. */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * The `.alert-info` (blue) banner as a kit component — the neutral/informational
 * counterpart to `ErrorAlert`/`SuccessAlert`/`WarningAlert` for the hand-rolled
 * blue note boxes. Renders `null` when there's no message and adds `role="note"`.
 */
export function InfoAlert({ message, onDismiss, className = '' }: InfoAlertProps) {
  if (!message) return null;
  return (
    <div className={['alert-info', className].filter(Boolean).join(' ')} role="note">
      <p>{message}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="action-link mt-2 underline">Dismiss</button>
      )}
    </div>
  );
}
