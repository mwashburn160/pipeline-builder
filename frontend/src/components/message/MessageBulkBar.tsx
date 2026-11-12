// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ArchiveRestore, EyeOff, Mail, MailOpen, Trash2, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/Checkbox';

interface SelectAllCheckboxProps {
  loadedCount: number;
  selectedCount: number;
  allMatching: boolean;
  onToggle: () => void;
}

/**
 * The list header's select-all box. Lives in the header row (not the bulk
 * bar) so an idle inbox spends no vertical space on selection — the bar only
 * appears once something is ticked. Indeterminate while SOME rows are.
 */
export function SelectAllCheckbox({ loadedCount, selectedCount, allMatching, onToggle }: SelectAllCheckboxProps) {
  if (loadedCount === 0) return null;
  const all = allMatching || (selectedCount > 0 && selectedCount === loadedCount);
  return (
    <Checkbox
      checked={all}
      ref={(el) => { if (el) el.indeterminate = !all && selectedCount > 0; }}
      onChange={onToggle}
      aria-label={all ? 'Deselect all messages' : 'Select all loaded messages'}
    />
  );
}

interface MessageBulkBarProps {
  loadedCount: number;
  /** How many loaded rows are ticked (the bar renders nothing at 0). */
  selectedCount: number;
  /** True once the person escalated to "all N matching". */
  allMatching: boolean;
  /** The server's total for the active tab + filters + search (null = unknown). */
  total: number | null;
  onSelectAllMatching: () => void;
  onClear: () => void;
  /** The list is the "Removed" view: Restore replaces Remove, read-state is moot. */
  removedView: boolean;
  /** Bulk view-state actions are offered (false in a read-only session). */
  canAct: boolean;
  /** Delete is offered at all (the viewer holds `messages:write`). */
  canDeleteAny: boolean;
  /** Every ticked row is one the server would let this viewer delete. */
  canDeleteSelected: boolean;
  /** An action is in flight — every control is disabled. */
  busy: boolean;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  /** Remove the ticked rows — or, after "Select all N", every matching message. */
  onRemove: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

const actionClass = 'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
const neutral = `${actionClass} text-fg-muted hover:text-fg hover:bg-surface-muted`;

/** Why an ids-only action is unavailable once "all N matching" is selected. */
const IDS_ONLY = 'Works on ticked messages only — untick "all" first';

/**
 * Bulk actions for the ticked rows.
 *
 * "Remove" clears THIS org's copy only (any reader may; it can be undone from
 * the Removed view), while "Delete" soft-deletes for everyone and is the
 * author's alone — so it is disabled, with the reason, the moment the
 * selection includes a message the viewer didn't send. Only Remove can act on
 * "all N matching": the others are per-row on the server.
 */
export function MessageBulkBar({
  loadedCount, selectedCount, allMatching, total, onSelectAllMatching, onClear,
  removedView, canAct, canDeleteAny, canDeleteSelected, busy,
  onMarkRead, onMarkUnread, onRemove, onRestore, onDelete,
}: MessageBulkBarProps) {
  if (selectedCount === 0) return null;
  const allLoaded = selectedCount === loadedCount;
  const matchingCount = total ?? loadedCount;
  // Escalation is only worth offering when the server holds more than the
  // loaded pages, and only for Remove (the one filter-scoped action).
  const canEscalate = allLoaded && !allMatching && !removedView && total !== null && total > loadedCount;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 border-b border-default bg-info-bg/40">
      <span className="text-xs font-medium text-fg" aria-live="polite">
        {allMatching ? `All ${matchingCount} selected` : `${selectedCount} selected`}
      </span>
      {canEscalate && (
        <button type="button" onClick={onSelectAllMatching} className="text-xs font-medium text-info hover:underline">
          Select all {total}
        </button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        {canAct && !removedView && (
          <>
            <button type="button" onClick={onMarkRead} disabled={busy || allMatching} className={neutral} title={allMatching ? IDS_ONLY : 'Mark read'} aria-label="Mark read">
              <MailOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Read</span>
            </button>
            <button type="button" onClick={onMarkUnread} disabled={busy || allMatching} className={neutral} title={allMatching ? IDS_ONLY : 'Mark unread'} aria-label="Mark unread">
              <Mail className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Unread</span>
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className={neutral}
              title="Remove from your organization's inbox — the sender keeps their copy, and you can restore it from Removed"
            >
              <EyeOff className="w-3.5 h-3.5" />
              Remove
            </button>
          </>
        )}
        {canAct && removedView && (
          <button type="button" onClick={onRestore} disabled={busy || allMatching} className={neutral} title={allMatching ? IDS_ONLY : 'Put back into your inbox'}>
            <ArchiveRestore className="w-3.5 h-3.5" />
            Restore
          </button>
        )}
        {canDeleteAny && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || allMatching || !canDeleteSelected}
            className={`${actionClass} text-danger hover:bg-danger-bg`}
            title={
              allMatching ? IDS_ONLY
                : canDeleteSelected ? 'Delete for everyone'
                  : 'Only messages you sent can be deleted — use Remove for the others'
            }
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="p-1 rounded-md text-fg-subtle hover:text-fg hover:bg-surface-muted"
          aria-label="Clear selection"
          title="Clear selection"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
