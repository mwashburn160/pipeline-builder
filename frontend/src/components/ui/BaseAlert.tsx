// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';

/** Alert variant → its CSS class, ARIA role, and dismiss-link class. The four
 *  public alert components (Error/Success/Info/Warning) are thin wrappers over
 *  this so the banner markup lives in one place. */
export type AlertVariant = 'error' | 'success' | 'info' | 'warning';

const VARIANTS: Record<AlertVariant, { cls: string; role: 'alert' | 'status'; dismiss: string }> = {
  error: { cls: 'alert-error', role: 'alert', dismiss: 'action-link-danger' },
  success: { cls: 'alert-success', role: 'status', dismiss: 'action-link' },
  // `note` is a DPUB role, inert in plain ARIA — screen readers announced info
  // banners as unlabelled text. `status` announces politely.
  info: { cls: 'alert-info', role: 'status', dismiss: 'action-link' },
  warning: { cls: 'alert-warning', role: 'alert', dismiss: 'action-link' },
};

interface BaseAlertProps {
  variant: AlertVariant;
  /** Banner content. Renders nothing when falsy (callers can pass state directly). */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  /** When provided, renders a "Retry" action — so a failed load isn't a dead end. */
  onRetry?: () => void;
  className?: string;
}

/** Shared alert banner. Renders `null` when there's no message. */
export function BaseAlert({ variant, message, onDismiss, onRetry, className = '' }: BaseAlertProps) {
  if (!message) return null;
  const v = VARIANTS[variant];
  return (
    <div className={[v.cls, className].filter(Boolean).join(' ')} role={v.role}>
      <p>{message}</p>
      {(onRetry || onDismiss) && (
        <div className="mt-2 flex items-center gap-3">
          {onRetry && (
            <button type="button" onClick={onRetry} className={`${v.dismiss} underline`}>Retry</button>
          )}
          {onDismiss && (
            <button type="button" onClick={onDismiss} className={`${v.dismiss} underline`}>Dismiss</button>
          )}
        </div>
      )}
    </div>
  );
}
