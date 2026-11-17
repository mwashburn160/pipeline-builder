// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { RetryError } from './RetryError';
import { CONCURRENCY_CONFLICT_MESSAGE } from '@/lib/api/concurrency';

interface ConcurrencyConflictAlertProps {
  /** Show the alert. Renders nothing when false. */
  show: boolean;
  /** Re-read the record and reset the form to it. */
  onReload: () => void;
  /** A reload is in flight. */
  reloading?: boolean;
  className?: string;
}

/**
 * The "someone else changed this since you opened it" banner an edit form shows
 * when its save was refused with a 412 (see `isConcurrencyConflict`), with the
 * Reload action that brings the form up to date.
 */
export function ConcurrencyConflictAlert({ show, onReload, reloading, className }: ConcurrencyConflictAlertProps) {
  if (!show) return null;
  return (
    <div data-testid="concurrency-conflict" className={className}>
      <RetryError message={CONCURRENCY_CONFLICT_MESSAGE} onRetry={onReload} retrying={reloading} retryLabel="Reload" />
    </div>
  );
}
