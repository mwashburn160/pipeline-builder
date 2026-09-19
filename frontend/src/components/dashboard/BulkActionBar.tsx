// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

/**
 * Row-selection state for a bulk-editable list (the pipelines and plugins
 * catalogs). `toggle` flips one id; `clear` empties the set.
 */
export function useRowSelection() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelectedIds(new Set()), []);
  return { selectedIds, toggle, clear };
}

interface BulkActionBarProps {
  /** Number of selected rows; the bar renders nothing at 0. */
  count: number;
  busy: boolean;
  onActivate: (isActive: boolean) => void;
  /** Opens the caller's delete confirmation (bulk delete is irreversible). */
  onDelete: () => void;
  onClear: () => void;
}

/**
 * Sticky bottom toolbar for the bulk actions a catalog list offers on its
 * selected rows — activate, deactivate, delete. Paired with a same-height
 * spacer ({@link BulkActionBarSpacer}) so the last rows aren't hidden under it.
 */
export function BulkActionBar({ count, busy, onActivate, onDelete, onClear }: BulkActionBarProps) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shadow-lg">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-3">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {count} selected
        </span>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="xs" onClick={() => onActivate(true)} disabled={busy}>
            Activate
          </Button>
          <Button variant="secondary" size="xs" onClick={() => onActivate(false)} disabled={busy}>
            Deactivate
          </Button>
          <Button variant="danger" size="xs" onClick={onDelete} disabled={busy}>
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </Button>
          <IconButton onClick={onClear} title="Clear selection" aria-label="Clear selection">
            <X className="w-4 h-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/** Reserves the bar's height at the end of the list while it is showing. */
export function BulkActionBarSpacer({ count }: { count: number }) {
  return count > 0 ? <div className="h-16" /> : null;
}
