// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { EyeOff, Trash2, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/Checkbox';

interface MessageBulkBarProps {
  /** Rows currently loaded in the list (selection never outlives them). */
  loadedCount: number;
  /** How many loaded rows are ticked. */
  selectedCount: number;
  /** True once the person escalated to "all N matching". */
  allMatching: boolean;
  /** The server's total for the active tab + filters + search (null = unknown). */
  total: number | null;
  /** Tick every loaded row (or untick them all, when they already are). */
  onToggleAllLoaded: () => void;
  /** Escalate a full-page selection to every matching message on the server. */
  onSelectAllMatching: () => void;
  onClear: () => void;
  /** Remove-from-inbox is offered (false in a read-only session). */
  canRemove: boolean;
  /** Delete is offered at all (the viewer holds `messages:write`). */
  canDeleteAny: boolean;
  /** Every ticked row is one the server would let this viewer delete. */
  canDeleteSelected: boolean;
  /** Remove the ticked rows — or, after "Select all N", every matching message. */
  onRemoveSelected: () => void;
  /**
   * Remove EVERY message matching the active tab + filters + search on the
   * server, loaded or not (the shortcut offered when nothing is ticked).
   */
  onRemoveMatching: () => void;
  /** Delete the ticked rows. Never offered against a filter: delete is per-row
   *  and author-only on the server. */
  onDelete: () => void;
}

const actionClass = 'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * The inbox's selection header: a select-all checkbox, the selection count, and
 * the bulk actions that apply to it.
 *
 * Two actions, kept distinct because they are different operations:
 * "Remove from inbox" clears THIS org's copy only (any reader may, nothing is
 * lost for the other party), while "Delete" soft-deletes the message for
 * everyone and is the author's alone — so it is disabled, with the reason,
 * the moment the selection includes a message the viewer didn't send.
 */
export function MessageBulkBar({
  loadedCount, selectedCount, allMatching, total,
  onToggleAllLoaded, onSelectAllMatching, onClear,
  canRemove, canDeleteAny, canDeleteSelected, onRemoveSelected, onRemoveMatching, onDelete,
}: MessageBulkBarProps) {
  if (loadedCount === 0) return null;
  const allLoaded = selectedCount > 0 && selectedCount === loadedCount;
  const some = selectedCount > 0 && !allLoaded;
  const matchingCount = total ?? loadedCount;
  // Only worth offering when the server holds more than the loaded pages.
  const canEscalate = allLoaded && !allMatching && total !== null && total > loadedCount;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 border-b border-default bg-surface">
      <Checkbox
        checked={allLoaded || allMatching}
        ref={(el) => { if (el) el.indeterminate = some && !allMatching; }}
        onChange={onToggleAllLoaded}
        aria-label={allLoaded ? 'Deselect all messages' : 'Select all loaded messages'}
      />

      {selectedCount === 0 ? (
        <>
          <span className="text-xs text-fg-subtle">Select</span>
          {/* No ticks: the shortcut acts on everything the filters describe —
              `total` is the SERVER's count, which is what will be removed. */}
          {canRemove && (total ?? 0) > 0 && (
            <button
              type="button"
              onClick={onRemoveMatching}
              className={`${actionClass} ml-auto text-danger hover:bg-danger-bg`}
            >
              <EyeOff className="w-3.5 h-3.5" />
              Remove all {total}
            </button>
          )}
        </>
      ) : (
        <>
          <span className="text-xs font-medium text-fg" aria-live="polite">
            {allMatching ? `All ${matchingCount} selected` : `${selectedCount} selected`}
          </span>
          {canEscalate && (
            <button type="button" onClick={onSelectAllMatching} className="text-xs font-medium text-info hover:underline">
              Select all {total}
            </button>
          )}
          <div className="ml-auto flex items-center gap-1">
            {canRemove && (
              <button
                type="button"
                onClick={onRemoveSelected}
                className={`${actionClass} text-fg-muted hover:text-fg hover:bg-surface-muted`}
                title="Remove from your organization's inbox — the sender keeps their copy"
              >
                <EyeOff className="w-3.5 h-3.5" />
                Remove
              </button>
            )}
            {canDeleteAny && (
              <button
                type="button"
                onClick={onDelete}
                disabled={allMatching || !canDeleteSelected}
                className={`${actionClass} text-danger hover:bg-danger-bg`}
                title={
                  allMatching ? 'Delete works on ticked messages only — untick "all" to delete'
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
        </>
      )}
    </div>
  );
}
