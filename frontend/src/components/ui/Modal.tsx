import { type ReactNode, type RefObject, useEffect, useId, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialogBehavior } from '@/hooks/useDialogBehavior';
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

  const panelClasses = [
    'modal-panel', maxWidth,
    tall && 'max-h-[90vh] flex flex-col',
  ].filter(Boolean).join(' ');

  const contentClasses = [
    'px-6 py-4',
    tall && 'flex-1 overflow-y-auto',
  ].filter(Boolean).join(' ');

  // Escape, the Tab trap, focus-in (including the late correction for a body
  // that is still loading), scroll lock and focus-restore all come from the
  // shared overlay hook — the same code SideDrawer runs. Escape goes through
  // `requestClose`, so a dirty form asks before discarding. `active: mounted`
  // holds everything until the portal (and so the panel) exists.
  useDialogBehavior({ panelRef, onClose: requestClose, initialFocusRef, active: mounted });

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
          <button onClick={requestClose} aria-label="Close dialog" className="text-fg-subtle hover:text-fg transition-colors ml-3 shrink-0">
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
