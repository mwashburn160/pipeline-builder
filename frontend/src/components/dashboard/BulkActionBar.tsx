// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { TOAST_OFFSET_CSS_VAR } from '@/lib/constants';

/**
 * Row-selection state for a bulk-editable list (the pipelines and plugins
 * catalogs, the users / invitations tables, the registry tag table).
 *
 * The set is the single source of truth and deliberately survives filter and
 * page changes — the typical flow is "search → check several → search again →
 * act on the union".
 *
 * - `toggle` flips one id.
 * - `toggleAll` is the header checkbox: given the ids currently eligible
 *   (the visible page, the *pending* rows, the tags in view), it deselects
 *   them all when every one is already selected and otherwise selects them
 *   all — leaving ids outside that set untouched.
 * - `allSelected` answers the header checkbox's `checked` for the same ids.
 * - `clear` empties the set; `replace` swaps it wholesale (e.g. keeping only
 *   the rows a partially-failed bulk action left behind).
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
  const toggleAll = useCallback((ids: readonly string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      // Decide from `prev`, not a caller-supplied flag, so the header checkbox
      // can't act on a stale "all selected" read.
      if (ids.length > 0 && ids.every((id) => prev.has(id))) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelectedIds(new Set()), []);
  const replace = useCallback((ids: Iterable<string>) => setSelectedIds(new Set(ids)), []);
  return { selectedIds, toggle, toggleAll, clear, replace };
}

/** Whether every id in `ids` is selected (false for an empty `ids`). */
export function allSelected(selectedIds: ReadonlySet<string>, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => selectedIds.has(id));
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
export function BulkActionBar(props: BulkActionBarProps) {
  if (props.count === 0) return null;
  return <VisibleBulkActionBar {...props} />;
}

/** Fallback when layout can't be measured (jsdom, a not-yet-painted bar). */
const FALLBACK_BAR_HEIGHT = '4rem';

/**
 * Publishes the bar's height as {@link TOAST_OFFSET_CSS_VAR} while it is on
 * screen, so the global toast stack lifts above it instead of covering its
 * buttons; cleared when the bar goes away.
 */
function useRaiseToastsAbove(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      const h = ref.current?.offsetHeight ?? 0;
      root.style.setProperty(TOAST_OFFSET_CSS_VAR, h > 0 ? `${h}px` : FALLBACK_BAR_HEIGHT);
    };
    publish();
    const observer = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(publish) : null;
    if (observer && ref.current) observer.observe(ref.current);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(TOAST_OFFSET_CSS_VAR);
    };
  }, [ref]);
}

function VisibleBulkActionBar({ count, busy, onActivate, onDelete, onClear }: BulkActionBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  useRaiseToastsAbove(ref);
  return (
    <div ref={ref} className="fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-default shadow-lg">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-3">
        <span className="text-sm font-medium text-fg-muted">
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
