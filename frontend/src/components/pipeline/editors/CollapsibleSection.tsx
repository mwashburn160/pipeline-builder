import { useState, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Props for {@link CollapsibleSection}. */
interface CollapsibleSectionProps {
  /** Section heading text. */
  title: string;
  /** Whether the section starts expanded (defaults to false). */
  defaultOpen?: boolean;
  /** Content rendered inside the collapsible body. */
  children: ReactNode;
  /** When true, displays a "configured" badge next to the title. */
  hasContent?: boolean;
}

/**
 * Collapsible form section with a toggle header.
 *
 * Renders a bordered container with a clickable header that expands/collapses
 * the child content. Shows a "configured" badge when hasContent is true to
 * indicate that the section has non-default values.
 */
export default function CollapsibleSection({ title, defaultOpen = false, children, hasContent }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors"
      >
        <span className="flex items-center">
          {title}
          {hasContent && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
              configured
            </span>
          )}
        </span>
        <ChevronDown
          className={`w-5 h-5 text-gray-400 dark:text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {isOpen && (
        <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700">
          {children}
        </div>
      )}
    </div>
  );
}
