// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';

interface SuccessAlertProps {
  /** Success text/content. Renders nothing when falsy. */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/** The `.alert-success` banner counterpart to {@link ErrorAlert}. */
export function SuccessAlert({ message, onDismiss, className = '' }: SuccessAlertProps) {
  if (!message) return null;
  return (
    <div className={['alert-success', className].filter(Boolean).join(' ')} role="status">
      <p>{message}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="action-link mt-2 underline">Dismiss</button>
      )}
    </div>
  );
}
