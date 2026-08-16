// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { BaseAlert } from './BaseAlert';

interface WarningAlertProps {
  /** Warning content. Renders nothing when falsy, so callers can pass state directly. */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/** The `.alert-warning` (amber) banner — caution counterpart to {@link ErrorAlert}. */
export function WarningAlert({ message, onDismiss, className }: WarningAlertProps) {
  return <BaseAlert variant="warning" message={message} onDismiss={onDismiss} className={className} />;
}
