// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { BaseAlert } from './BaseAlert';

interface InfoAlertProps {
  /** Info content. Renders nothing when falsy, so callers can pass state directly. */
  message?: ReactNode;
  /** When provided, renders a "Dismiss" link that invokes this. */
  onDismiss?: () => void;
  className?: string;
}

/** The `.alert-info` (blue) banner — informational counterpart to {@link ErrorAlert}. */
export function InfoAlert({ message, onDismiss, className }: InfoAlertProps) {
  return <BaseAlert variant="info" message={message} onDismiss={onDismiss} className={className} />;
}
