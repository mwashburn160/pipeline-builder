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
 * A pipeline-editor section: the shared `Disclosure` with a string title and
 * the editor's "configured" badge, which tells someone scanning a long form
 * which collapsed sections already hold values. A disclosure that needs no
 * badge uses `@/components/ui/Disclosure` directly.
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
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-info-bg text-info-strong">
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
