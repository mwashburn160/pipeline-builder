import { type ReactNode, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Shared disclosure (expand/collapse) primitive.
 *
 * Consolidates four previously divergent disclosure widgets:
 *  - `pipeline/editors/CollapsibleSection` (custom button + local isOpen)
 *  - `pipeline/DeployedPipelinesPanel`     (`<details>` with controlled open)
 *  - `registry/RecentActionsPanel`         (custom button + local open)
 *  - `registry/ManifestDetail`'s `TagsForDigest` (`<details>` + manualOpen override)
 *
 * Built on the native `<details>` element so we inherit keyboard handling,
 * focus management, and screen-reader semantics for free. Open/close state
 * can be:
 *   - uncontrolled (use `defaultOpen`)
 *   - controlled   (drive via `open` + `onToggle`)
 *
 * The header is rendered inside `<summary>`. A chevron icon is appended on
 * the right by default and rotates 180deg when open (driven by Tailwind's
 * `group-open:` modifier — the root `<details>` carries a `group` class).
 * Pass a fully custom `title` (ReactNode) if you need icons, badges, or
 * action buttons in the header — see `DeployedPipelinesPanel` for an
 * example with an inline refresh button.
 */

/** Props for {@link Disclosure}. */
export interface DisclosureProps {
  /** Header content. Accepts a string or a custom node (icons, badges, action buttons, etc.). */
  title: ReactNode;
  /** Content rendered inside the disclosed body. */
  children: ReactNode;
  /** Starting open state for uncontrolled usage. Ignored if `open` is provided. */
  defaultOpen?: boolean;
  /** Controlled open state. When provided the consumer owns the state and must update via `onToggle`. */
  open?: boolean;
  /** Fired whenever the native `<details>` toggle event fires with the new open value. */
  onToggle?: (open: boolean) => void;
  /** Extra classes on the root `<details>` element. Replaces the default root styling when provided. */
  className?: string;
  /** Extra classes on the `<summary>` element. Replaces the default summary styling when provided. */
  summaryClassName?: string;
  /** Extra classes on the body wrapper that holds `children`. Replaces the default body styling when provided. */
  bodyClassName?: string;
  /** When false, hides the default chevron (use when the title node renders its own affordance). */
  showChevron?: boolean;
}

const DEFAULT_ROOT_CLASS =
  'group border border-gray-200 dark:border-gray-700 rounded-xl';

const DEFAULT_SUMMARY_CLASS =
  'cursor-pointer list-none w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors';

const DEFAULT_BODY_CLASS = 'px-4 pb-4 border-t border-gray-200 dark:border-gray-700';

export function Disclosure({
  title,
  children,
  defaultOpen,
  open,
  onToggle,
  className,
  summaryClassName,
  bodyClassName,
  showChevron = true,
}: DisclosureProps) {
  const isControlled = open !== undefined;

  const handleToggle = useCallback(
    (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      onToggle?.(e.currentTarget.open);
    },
    [onToggle]
  );

  // For uncontrolled mode we pass `open={defaultOpen}` on initial render only —
  // React forwards this as the `open` attribute, and the native element manages
  // toggling internally afterward (because we never re-pass `open`). For
  // controlled mode we always pass the current `open` prop.
  const detailsOpenProp = isControlled ? { open } : defaultOpen ? { open: true } : {};

  // The root carries `group` so the chevron can rotate via `group-open:`.
  // Callers that provide a custom `className` are responsible for including
  // `group` themselves if they want the chevron rotation. To keep this
  // painless we always ensure `group` is present.
  const rootClass = className ? `group ${className}` : DEFAULT_ROOT_CLASS;

  return (
    <details {...detailsOpenProp} onToggle={handleToggle} className={rootClass}>
      <summary className={summaryClassName ?? DEFAULT_SUMMARY_CLASS}>
        <span className="flex-1 min-w-0 flex items-center gap-2">{title}</span>
        {showChevron && (
          <ChevronDown
            className="w-5 h-5 text-gray-400 dark:text-gray-500 transition-transform group-open:rotate-180 shrink-0"
            aria-hidden="true"
          />
        )}
      </summary>
      <div className={bodyClassName ?? DEFAULT_BODY_CLASS}>{children}</div>
    </details>
  );
}

export default Disclosure;
