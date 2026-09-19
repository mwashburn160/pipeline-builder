import { type ReactNode, type RefObject, useEffect, useId, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from './ConfirmDialog';

/** Props for the Modal component. */
interface ModalProps {
  /** Modal title displayed in the header */
  title: string;
  /** Optional icon rendered before the title (e.g. a status/severity glyph). */
  titleIcon?: ReactNode;
  /** Callback when the modal is closed (via Escape, backdrop click, or close button) */
  onClose: () => void;
  /** Element to focus on open instead of the first focusable (e.g. a form's
   *  primary input, so the header close button isn't focused first). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Tailwind max-width class for the modal panel */
  maxWidth?: string;
  /** When true, the modal expands to 90vh with a scrollable content area */
  tall?: boolean;
  children: ReactNode;
  /** Content rendered in a sticky footer area below the main content */
  footer?: ReactNode;
  /** Content rendered between the header and the scrollable body (e.g. tabs) */
  subHeader?: ReactNode;
  /** Content rendered between the scrollable body and the footer (e.g. JSON preview) */
  preFooter?: ReactNode;
  /** Optional ref attached to the scrollable content container */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /**
   * The form inside has unsaved edits. Escape / backdrop / the X then ask before
   * discarding instead of closing outright — a misplaced click used to wipe a
   * 20-field plugin edit or a half-written message with no warning and no undo.
   * Explicit in-form actions (Cancel/Save) call `onClose` directly and bypass
   * this, as they should.
   */
  dirty?: boolean;
  /** Body text for the discard prompt. Defaults to a generic warning. */
  discardMessage?: string;
}

/**
 * Returns all focusable elements within a container.
 * @param container - The DOM element to search within
 * @returns Array of focusable HTML elements
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

/** Accessible modal dialog with focus trapping, Escape-to-close, and backdrop click dismissal. */
export function Modal({
  title, titleIcon, onClose, initialFocusRef, maxWidth = 'max-w-md', tall = false,
  children, footer, subHeader, preFooter, scrollRef,
  dirty = false,
  discardMessage,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<Element | null>(null);
  // Stable id so the dialog can reference its visible title via
  // aria-labelledby — more meaningful to screen readers than the
  // duplicated aria-label that was here before.
  const titleId = useId();

  // Render into a portal on document.body so the `position: fixed` backdrop is
  // measured against the viewport, not a transformed/filtered ancestor. Inside
  // the dashboard the content is wrapped in framer-motion (`transform`) and a
  // `backdrop-blur` header, both of which create a containing block that would
  // otherwise clamp the "fixed" overlay to the content column — rendering it as
  // dark side-bands instead of a full-screen backdrop. `mounted` guards SSR
  // (no `document` on the server).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Dismissal guard: with unsaved edits, Escape/backdrop/X open a discard prompt
  // instead of closing. Held in a ref for the keydown handler, whose identity is
  // deliberately stable (see the focus-effect note below).
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  }, [dirty, onClose]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  const panelClasses = [
    'modal-panel', maxWidth,
    tall && 'max-h-[90vh] flex flex-col',
  ].filter(Boolean).join(' ');

  const contentClasses = [
    'px-6 py-4',
    tall && 'flex-1 overflow-y-auto',
  ].filter(Boolean).join(' ');

  // Close on Escape — but ONLY the dialog that actually contains focus. With
  // stacked dialogs every instance binds its own `document` keydown listener;
  // `stopPropagation()` does not stop other listeners on the *same* target, so
  // it can't prevent a parent dialog from also closing — `stopImmediate...`
  // does. Gating the close on `focusInside` (the focus trap keeps focus in the
  // topmost dialog) means only the topmost closes, and stopping immediate
  // propagation keeps the parents' listeners from firing.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      const focusInside = panelRef.current?.contains(document.activeElement);
      if (focusInside) {
        e.stopImmediatePropagation();
        requestCloseRef.current();
      }
      return;
    }

    // Focus trap. Three cases on Tab:
    //  - Focus is outside the panel (e.g. dev tools stole it, parent
    //    refocused something): pull it back to the first focusable.
    //  - Focus is on the last element + Tab forward: wrap to first.
    //  - Focus is on the first element + Shift+Tab: wrap to last.
    if (e.key === 'Tab' && panelRef.current) {
      const panel = panelRef.current;
      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        // Nothing focusable; keep the panel itself focused so Tab doesn't
        // escape into the background.
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);

      if (!inside) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onClose]);

  // What we auto-focused on open, and whether the caller's preferred element
  // ever got it. A dialog whose body is still loading (StepUpModal renders a
  // spinner until the account's factors come back) has `initialFocusRef.current
  // === null` at mount, so the fallback below wins and nothing ever corrects it
  // — every step-up opened focused on "Close". The second effect fixes that.
  const autoFocused = useRef<HTMLElement | null>(null);
  const focusedInitial = useRef(false);

  // Focus management + scroll lock — runs ONCE when the modal mounts (keyed on
  // `mounted`, not `handleKeyDown`). Keeping focus-on-open out of the keydown
  // effect is critical: callers pass an inline `onClose`, so `handleKeyDown`'s
  // identity changes every render; if focusing lived here it would re-fire on
  // every keystroke and yank focus to the close button (input loses focus after
  // one letter).
  useEffect(() => {
    if (!mounted) return;
    previousActiveElement.current = document.activeElement;

    // Focus the caller-specified element (e.g. a form's primary input) if given,
    // else the first focusable element on open.
    if (panelRef.current) {
      const focusable = getFocusableElements(panelRef.current);
      const preferred = initialFocusRef?.current ?? null;
      const target = preferred ?? focusable[0];
      target?.focus();
      autoFocused.current = target ?? null;
      focusedInitial.current = !!preferred;
    }

    // Prevent background scrolling. Capture the prior value so we restore
    // whatever the host page had set (mirrors CommandPalette); blindly
    // resetting to '' would clobber a parent's intentional `hidden`.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      // Restore focus to the element that opened the modal — but only if it's
      // still in the document (a parent re-render may have replaced the trigger;
      // .focus() on a detached node is a no-op but can throw under test runners).
      const prev = previousActiveElement.current;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
  }, [mounted]);

  // Late focus: the caller's preferred element arrived after mount (its content
  // was still loading). Deliberately NOT keyed on a dependency array — it has to
  // notice a ref, which no dependency can describe — but it acts at most once,
  // and only while focus is still sitting on the element we auto-focused (or on
  // nothing). If the user has already tabbed or clicked somewhere, their focus
  // is theirs; yanking it would be worse than the wrong initial target. The
  // focus trap and the restore-on-close in the mount effect are untouched.
  useEffect(() => {
    if (!mounted || focusedInitial.current) return;
    const target = initialFocusRef?.current;
    if (!target || !target.isConnected) return;
    const active = document.activeElement;
    const undisturbed = active === autoFocused.current || active === document.body || active === null;
    if (undisturbed) {
      target.focus();
      autoFocused.current = target;
    }
    // Either way the one-shot is spent: the content has rendered, so a later
    // steal would be a surprise rather than a correction.
    focusedInitial.current = true;
  });

  // Keydown listener (Escape + focus trap) — re-binds when `handleKeyDown`
  // changes. No focus side effects here, so re-binding per render is harmless.
  useEffect(() => {
    if (!mounted) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mounted, handleKeyDown]);

  if (!mounted) return null;

  return createPortal(
    <>
    <div className="modal-backdrop" onClick={requestClose} role="presentation">
      <div
        ref={panelRef}
        className={panelClasses}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 min-w-0">
            {titleIcon}
            <h2 id={titleId} className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate">{title}</h2>
          </div>
          <button onClick={requestClose} aria-label="Close dialog" className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors ml-3 shrink-0">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Sub-header (e.g. tabs) */}
        {subHeader}

        {/* Scrollable Content */}
        <div ref={scrollRef} className={contentClasses}>
          {children}
        </div>

        {/* Pre-footer (e.g. JSON preview) */}
        {preFooter}

        {/* Footer */}
        {footer && (
          <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 bg-gray-50 dark:bg-gray-800/50 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
    {confirmingDiscard && (
      <ConfirmDialog
        title="Discard changes?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onCancel={() => setConfirmingDiscard(false)}
        onConfirm={() => { setConfirmingDiscard(false); onClose(); }}
      >
        <p>{discardMessage ?? 'Your edits here have not been saved. Closing now loses them.'}</p>
      </ConfirmDialog>
    )}
    </>,
    document.body,
  );
}
