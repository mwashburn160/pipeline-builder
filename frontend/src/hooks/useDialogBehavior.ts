// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, type RefObject } from 'react';

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
 * The ONE implementation — `Modal` (and so every dialog built on it) and
 * `SideDrawer` both run on this. It was hand-written per overlay and drifted:
 * the log-details drawer had every part except the Tab trap, so focus silently
 * walked into the log table behind it.
 *
 * Escape only closes the panel that CONTAINS focus, and stops other same-target
 * listeners, so stacked overlays close one at a time (top first).
 *
 * `initialFocusRef` may point at an element that doesn't exist yet at open (a
 * dialog whose body is still loading — StepUpModal shows a spinner until the
 * account's factors arrive). Focus then lands on the first focusable, and moves
 * to the preferred element ONCE when it appears, unless the person has already
 * moved focus themselves.
 *
 * Render the overlay only while it's open (mount = open), or pass `active`.
 */
export function useDialogBehavior({ panelRef, onClose, initialFocusRef, active = true }: {
  panelRef: RefObject<HTMLElement | null>;
  /** Called on Escape. Pass a guarded close (e.g. "confirm discard?") here, not
   *  necessarily the raw close — this is what the keyboard dismissal does. */
  onClose: () => void;
  /** Element to focus on open; defaults to the first focusable in the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Set false while the overlay is closed (when the caller keeps it mounted). */
  active?: boolean;
}) {
  // `onClose` is usually an inline arrow. Reading it through a ref keeps the
  // keydown listener bound once per open instead of re-binding every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel) return;

    if (e.key === 'Escape') {
      if (panel.contains(document.activeElement)) {
        e.stopImmediatePropagation();
        onCloseRef.current();
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
  }, [panelRef]);

  useEffect(() => {
    if (!active) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, handleKeyDown]);

  // What we auto-focused on open, and whether the caller's preferred element
  // has had its turn yet (see the late-focus effect below).
  const autoFocused = useRef<HTMLElement | null>(null);
  const focusedInitial = useRef(false);

  // Focus + scroll lock run ONCE per open. Keeping them out of the keydown
  // effect matters: re-running this per render would yank focus back to the top
  // of the panel on every keystroke (an input losing focus after one letter).
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement;
    const preferred = initialFocusRef?.current ?? null;
    const target = preferred ?? (panelRef.current ? focusableWithin(panelRef.current)[0] : null);
    target?.focus();
    autoFocused.current = target ?? null;
    focusedInitial.current = !!preferred;

    // Capture the prior value so whatever the host page had set survives;
    // blindly resetting to '' would clobber a parent's intentional `hidden`.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      // Only if still in the document: a re-render may have replaced the trigger
      // (.focus() on a detached node is a no-op but can throw under test runners).
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable; run once per open
  }, [active]);

  // Late focus: the preferred element arrived after open (its content was still
  // loading). Deliberately NOT keyed on a dependency array — it has to notice a
  // ref, which no dependency can describe — but it acts at most once per open,
  // and only while focus still sits where we put it (or nowhere). If the person
  // has already tabbed or clicked elsewhere, their focus is theirs.
  useEffect(() => {
    if (!active || focusedInitial.current) return;
    const target = initialFocusRef?.current;
    if (!target || !target.isConnected) return;
    const current = document.activeElement;
    if (current === autoFocused.current || current === document.body || current === null) {
      target.focus();
      autoFocused.current = target;
    }
    // Either way the one-shot is spent: the content has rendered, so a later
    // steal would be a surprise rather than a correction.
    focusedInitial.current = true;
  });
}
