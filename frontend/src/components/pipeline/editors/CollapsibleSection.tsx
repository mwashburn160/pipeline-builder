import { type ReactNode } from 'react';
import { Disclosure } from '@/components/ui/Disclosure';

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
 * Thin wrapper around the shared `Disclosure` primitive that preserves the
 * pipeline-editor-specific "configured" badge UX. New code should use
 * `@/components/ui/Disclosure` directly; this file remains so the many
 * existing editor imports keep working without a sweeping rename.
 */
export default function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  hasContent,
}: CollapsibleSectionProps) {
  return (
    <Disclosure
      defaultOpen={defaultOpen}
      title={
        <>
          <span>{title}</span>
          {hasContent && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
              configured
            </span>
          )}
        </>
      }
    >
      {children}
    </Disclosure>
  );
}
