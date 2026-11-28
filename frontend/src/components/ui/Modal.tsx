import { type ReactNode, type RefObject, useEffect, useId, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogBehavior } from '@/hooks/useDialogBehavior';
import { ConfirmDialog } from './ConfirmDialog';
import { TAP_TARGET } from './responsive';

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
  /**
   * A long-form dialog (an editor): capped at 90vh rather than the full
   * viewport, so the page stays visible around it. Every dialog already caps
   * its height and scrolls its body; this only tightens the cap.
   */
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
   * discarding instead of closing outright, so a misplaced click can't wipe a
   * 20-field plugin edit or a half-written message with no warning and no undo.
   * Explicit in-form actions (Cancel/Save) call `onClose` directly and bypass
   * this, as they should.
   */
  dirty?: boolean;
  /** Body text for the discard prompt. Defaults to a generic warning. */
  discardMessage?: string;
}

/** Accessible modal dialog with focus trapping, Escape-to-close, and backdrop click dismissal. */
export function Modal({
  title, titleIcon, onClose, initialFocusRef, maxWidth = 'max-w-md', tall = false,
  children, footer, subHeader, preFooter, scrollRef,
  dirty = false,
  discardMessage,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
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
  // instead of closing.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const requestClose = useCallback(() => {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  }, [dirty, onClose]);

  // On a phone (below `sm`) every dialog is a full-height sheet: header pinned
  // at the top, footer at the bottom, and only the body scrolls. A centred box
  // taller than the screen otherwise loses its header off the top, out of
  // reach, with the backdrop's flex centring.
  // From `sm` up EVERY dialog is capped to the viewport (less the backdrop's
  // padding) and scrolls its body between a pinned header and footer: a long
  // form's Send/Save stays on screen at any window height. `tall` caps it
  // tighter, at 90vh.
  const panelClasses = [
    'modal-panel', maxWidth,
    'max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:p-0 max-sm:flex max-sm:flex-col',
    'sm:flex sm:flex-col',
    tall ? 'sm:max-h-[90vh]' : 'sm:max-h-[calc(100dvh-2rem)]',
  ].join(' ');

  const contentClasses = 'px-4 sm:px-6 py-4 max-sm:flex-1 max-sm:overflow-y-auto max-sm:min-h-0 sm:flex-1 sm:min-h-0 sm:overflow-y-auto';

  // Escape, the Tab trap, focus-in (including the late correction for a body
  // that is still loading), scroll lock and focus-restore all come from the
  // shared overlay hook — the same code SideDrawer runs. Escape goes through
  // `requestClose`, so a dirty form asks before discarding. `active: mounted`
  // holds everything until the portal (and so the panel) exists.
  useDialogBehavior({ panelRef, onClose: requestClose, initialFocusRef, active: mounted });

  if (!mounted) return null;

  return createPortal(
    <>
    <div className="modal-backdrop max-sm:p-0" onClick={requestClose} role="presentation">
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- stopPropagation only, see onClick */}
      <div
        ref={panelRef}
        className={panelClasses}
        // Not an interaction: it only keeps a click INSIDE the dialog from
        // reaching the backdrop's close handler (React bubbles through portals,
        // so a target-check on the backdrop would not cover nested popovers).
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-4 sm:px-6 py-4 max-sm:py-2 border-b border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {titleIcon}
            <h2 id={titleId} className="h2 text-lg truncate">{title}</h2>
          </div>
          <button onClick={requestClose} aria-label="Close dialog" className={`text-fg-subtle hover:text-fg transition-colors ml-3 shrink-0 max-sm:-mr-2.5 ${TAP_TARGET}`}>
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
          <div className="border-t border-default px-4 sm:px-6 py-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] bg-surface-muted sm:rounded-b-2xl shrink-0">
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
