// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BaseAlert } from './BaseAlert';

interface ErrorAlertProps {
  /** Error text. Renders nothing when falsy, so callers can pass state directly. */
  message?: string | null;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  /** When provided, renders a "Retry" action beside Dismiss. Pass the list's
   *  `refresh` so a failed load isn't a dead end with a page reload as the
   *  only way forward. */
  onRetry?: () => void;
  className?: string;
}

/**
 * The `.alert-error` banner (a thin wrapper over {@link BaseAlert}). Renders
 * `null` when there's no message, so `<ErrorAlert message={error} onDismiss={…}/>`
 * renders nothing for an empty message.
 */
export function ErrorAlert({ message, onDismiss, onRetry, className }: ErrorAlertProps) {
  return <BaseAlert variant="error" message={message ?? undefined} onDismiss={onDismiss} onRetry={onRetry} className={className} />;
}
