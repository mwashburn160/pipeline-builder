import type { ReactNode, RefObject } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  maxWidth?: string;
  tall?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  subHeader?: ReactNode;
  preFooter?: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
}

export function Modal({
  title, onClose, maxWidth = 'max-w-md', tall = false,
  children, footer, subHeader, preFooter, scrollRef,
}: ModalProps) {
  const panelClasses = [
    'modal-panel', maxWidth,
    tall && 'max-h-[90vh] flex flex-col',
  ].filter(Boolean).join(' ');

  const contentClasses = [
    'px-6 py-4',
    tall && 'flex-1 overflow-y-auto',
  ].filter(Boolean).join(' ');

  return (
    <div className="modal-backdrop">
      <div className={panelClasses} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 transition-colors">
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
