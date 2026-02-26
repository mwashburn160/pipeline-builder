import { type ReactNode, type RefObject, useEffect, useRef, useCallback } from 'react';

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

  const panelClasses = [
    'modal-panel', maxWidth,
    tall && 'max-h-[90vh] flex flex-col',
  ].filter(Boolean).join(' ');

  const contentClasses = [
    'px-6 py-4',
    tall && 'flex-1 overflow-y-auto',
  ].filter(Boolean).join(' ');

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }

    // Focus trap
    if (e.key === 'Tab' && panelRef.current) {
      const focusable = getFocusableElements(panelRef.current);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
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

    // Prevent background scrolling
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      // Restore focus to the element that opened the modal
      if (previousActiveElement.current instanceof HTMLElement) {
        previousActiveElement.current.focus();
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
        aria-label={title}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">{title}</h2>
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
