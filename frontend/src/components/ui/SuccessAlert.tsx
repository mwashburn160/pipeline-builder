// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { BaseAlert } from './BaseAlert';

interface SuccessAlertProps {
  /** Success text/content. Renders nothing when falsy. */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/** The `.alert-success` banner counterpart to {@link ErrorAlert}. */
export function SuccessAlert({ message, onDismiss, className }: SuccessAlertProps) {
  return <BaseAlert variant="success" message={message} onDismiss={onDismiss} className={className} />;
}
