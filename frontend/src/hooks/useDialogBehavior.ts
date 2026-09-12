// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, type RefObject } from 'react';

/** Everything tabbable inside a container, in DOM order. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * The behaviour any overlay owes a keyboard or screen-reader user: focus moves
 * in on open, Tab cycles WITHIN the panel (never into the page behind), Escape
 * closes, the background can't scroll, and focus returns to whatever opened it.
 *
 * Extracted because it was hand-written per overlay and drifted — the log-details
 * drawer had every part except the Tab trap, so focus silently walked into the
 * log table behind it.
 *
 * Escape only closes the panel that CONTAINS focus, and stops other same-target
 * listeners, so stacked overlays close one at a time (top first).
 *
 * Render the overlay only while it's open (mount = open), or pass `active`.
 */
export function useDialogBehavior({ panelRef, onClose, initialFocusRef, active = true }: {
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Element to focus on open; defaults to the first focusable in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Set false while the overlay is closed (when the caller keeps it mounted). */
  active?: boolean;
}) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel) return;

    if (e.key === 'Escape') {
      if (panel.contains(document.activeElement)) {
        e.stopImmediatePropagation();
        onClose();
      }
      return;
    }

    if (e.key !== 'Tab') return;

    const focusable = focusableWithin(panel);
    if (focusable.length === 0) {
      // Nothing to focus — keep Tab from escaping into the page behind.
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active_ = document.activeElement;
    const inside = active_ instanceof Node && panel.contains(active_);

    if (!inside) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active_ === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active_ === last) {
      e.preventDefault();
      first.focus();
    }
  }, [panelRef, onClose]);

  useEffect(() => {
    if (!active) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, handleKeyDown]);

  // Focus + scroll lock run ONCE per open. Keeping them out of the keydown
  // effect matters: `onClose` is usually an inline arrow, so `handleKeyDown`
  // changes identity every render — re-running this would yank focus back to
  // the top of the panel on every keystroke.
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement;
    const target = initialFocusRef?.current ?? (panelRef.current ? focusableWithin(panelRef.current)[0] : null);
    target?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      // Only if still in the document: a re-render may have replaced the trigger.
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable; run once per open
  }, [active]);
}
