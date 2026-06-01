import { type ReactNode, type RefObject, useEffect, useId, useRef, useCallback } from 'react';

/** Props for the Modal component. */
interface ModalProps {
  /** Modal title displayed in the header */
  title: string;
  /** Callback when the modal is closed (via Escape, backdrop click, or close button) */
  onClose: () => void;
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
  title, onClose, maxWidth = 'max-w-md', tall = false,
  children, footer, subHeader, preFooter, scrollRef,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<Element | null>(null);
  // Stable id so the dialog can reference its visible title via
  // aria-labelledby — more meaningful to screen readers than the
  // duplicated aria-label that was here before.
  const titleId = useId();

  const panelClasses = [
    'modal-panel', maxWidth,
    tall && 'max-h-[90vh] flex flex-col',
  ].filter(Boolean).join(' ');

  const contentClasses = [
    'px-6 py-4',
    tall && 'flex-1 overflow-y-auto',
  ].filter(Boolean).join(' ');

  // Close on Escape. Only swallow the event if the focused element lives
  // inside this modal's panel — otherwise a stacked dialog or some other
  // listener should get a shot at the key (and we'd close prematurely if
  // focus had been stolen elsewhere).
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      const focusInside = panelRef.current?.contains(document.activeElement);
      if (focusInside) {
        e.stopPropagation();
      }
      onClose();
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

  // Set up event listeners and focus management
  useEffect(() => {
    previousActiveElement.current = document.activeElement;
    document.addEventListener('keydown', handleKeyDown);

    // Focus the close button (first focusable element) on mount
    if (panelRef.current) {
      const focusable = getFocusableElements(panelRef.current);
      if (focusable.length > 0) {
        focusable[0].focus();
      }
    }

    // Prevent background scrolling. Capture the prior value so we restore
    // whatever the host page had set (mirrors CommandPalette); blindly
    // resetting to '' would clobber a parent's intentional `hidden`.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      // Restore focus to the element that opened the modal — but only if
      // it is still in the document. A parent component may have re-rendered
      // and replaced the trigger; calling .focus() on a detached node is a
      // no-op but can throw under some test runners.
      const prev = previousActiveElement.current;
      if (prev instanceof HTMLElement && prev.isConnected) {
        prev.focus();
      }
    };
  }, [handleKeyDown]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
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
          <h2 id={titleId} className="text-lg font-medium text-gray-900 dark:text-gray-100">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors">
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
  );
}
