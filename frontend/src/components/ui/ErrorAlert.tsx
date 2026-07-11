// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

interface ErrorAlertProps {
  /** Error text. Renders nothing when falsy, so callers can pass state directly. */
  message?: string | null;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * The `.alert-error` banner that was hand-repeated across ~14 pages. Renders
 * `null` when there's no message, so `<ErrorAlert message={error} onDismiss={…}/>`
 * is a drop-in for the old `{error && (<div className="alert-error">…)}` block —
 * and adds the `role="alert"` the inline copies lacked.
 */
export function ErrorAlert({ message, onDismiss, className = '' }: ErrorAlertProps) {
  if (!message) return null;
  return (
    <div className={['alert-error', className].filter(Boolean).join(' ')} role="alert">
      <p>{message}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="action-link-danger mt-2 underline">Dismiss</button>
      )}
    </div>
  );
}
