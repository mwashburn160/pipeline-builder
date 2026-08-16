// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BaseAlert } from './BaseAlert';

interface ErrorAlertProps {
  /** Error text. Renders nothing when falsy, so callers can pass state directly. */
  message?: string | null;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * The `.alert-error` banner (a thin wrapper over {@link BaseAlert}). Renders
 * `null` when there's no message, so `<ErrorAlert message={error} onDismiss={…}/>`
 * is a drop-in for the old `{error && (<div className="alert-error">…)}` block.
 */
export function ErrorAlert({ message, onDismiss, className }: ErrorAlertProps) {
  return <BaseAlert variant="error" message={message ?? undefined} onDismiss={onDismiss} className={className} />;
}
