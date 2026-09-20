// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface BulkSelectionBannerProps {
  count: number;
  /** Singular noun for the rows ("user", "invitation") — pluralised here. */
  noun: string;
  /** Verb on the destructive button ("Delete", "Revoke"). */
  actionLabel: string;
  onClear: () => void;
  /** Opens the caller's confirmation — the bulk action is irreversible. */
  onAction: () => void;
}

/**
 * "N selected" strip above a bulk-editable table, with clear + the one
 * destructive action. Renders nothing at zero.
 *
 * The users and invitations pages each carried their own copy of this and the
 * summary below, identical apart from the noun and the verb.
 */
export function BulkSelectionBanner({ count, noun, actionLabel, onClear, onAction }: BulkSelectionBannerProps) {
  if (count === 0) return null;
  return (
    <div className="mb-3 flex items-center justify-between rounded-lg border border-info-border bg-info-bg px-3 py-2 text-sm">
      <span className="text-info-strong">
        <strong>{count}</strong> {noun}{count === 1 ? '' : 's'} selected
      </span>
      <div className="flex items-center gap-2">
        <button onClick={onClear} className="action-link text-sm">Clear</button>
        <Button
          variant="danger"
          onClick={onAction}
          className="inline-flex items-center gap-1 text-sm"
        >
          <Trash2 className="h-4 w-4" /> {actionLabel} {count}
        </Button>
      </div>
    </div>
  );
}

interface BulkResultSummaryProps {
  /** How many rows the action could not act on — green at 0, amber otherwise. */
  failed: number;
  /** Per-row failure lines, already capped by the caller. */
  errors: string[];
  /** The one-line outcome sentence ("Bulk delete finished — 3 deleted, 1 failed."). */
  children: ReactNode;
  /** Renders a Dismiss link when given. */
  onDismiss?: () => void;
}

/** Outcome of a finished bulk action, with the first few per-row failures. */
export function BulkResultSummary({ failed, errors, children, onDismiss }: BulkResultSummaryProps) {
  return (
    <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${failed === 0 ? 'bg-success-bg text-success-strong' : 'bg-warning-bg text-warning-strong'}`}>
      <div>{children}</div>
      {errors.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {errors.map((e) => <li key={e}><code>{e}</code></li>)}
        </ul>
      )}
      {onDismiss && (
        <button onClick={onDismiss} className="mt-1 text-xs underline">Dismiss</button>
      )}
    </div>
  );
}
