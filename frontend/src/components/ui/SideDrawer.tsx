import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { ModalPortal } from './ModalPortal';

interface SideDrawerProps {
  /** Heading shown in the drawer header. */
  title: ReactNode;
  /** Optional secondary line under the title (badges, timestamp, …). */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name for the dialog. */
  ariaLabel?: string;
}

/**
 * Right-edge slide-in detail drawer. Overlays the page (portaled to <body> so
 * `fixed` measures against the viewport, not the dashboard's transformed
 * ancestors). Closes on Escape, backdrop click, and the X button; focus moves
 * to the close button on open and restores to the trigger on close.
 *
 * Shared shell for record-detail views (e.g. the audit log). Only render it
 * when there's something to show (`{selected && <SideDrawer …>}`).
 */
export function SideDrawer({ title, subtitle, onClose, children, ariaLabel }: SideDrawerProps) {
  const previousActiveElement = useRef<Element | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    previousActiveElement.current = document.activeElement;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      const prev = previousActiveElement.current;
      if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    };
    // Focus + scroll-lock run once on mount (render the drawer only while open).
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-40" role="presentation" onClick={onClose}>
        <div className="absolute inset-0 bg-black/30" />
        <aside
          className="absolute top-0 right-0 h-full w-full max-w-2xl bg-white dark:bg-gray-900 shadow-2xl flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">{title}</h2>
              {subtitle && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 flex-wrap">{subtitle}</div>}
            </div>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close details"
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors flex-shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">{children}</div>
        </aside>
      </div>
    </ModalPortal>
  );
}
