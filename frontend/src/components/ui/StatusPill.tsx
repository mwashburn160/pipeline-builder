import type { ReactNode } from 'react';

/** Props for the StatusPill component. */
interface StatusPillProps {
  /** Pill content (label, optional leading icon) */
  children: ReactNode;
  /**
   * Color classes for the pill (background + text). Passed through verbatim so
   * callers keep full control over their status/severity palette.
   */
  className?: string;
  /** When true, adds `gap-1` between the icon and label. */
  gap?: boolean;
}

/**
 * Small rounded status/severity pill.
 *
 * Renders the exact hand-rolled wrapper class string that was previously
 * duplicated across the compliance/quota/message components, so migrating a
 * call site produces byte-identical DOM. Color classes are supplied by the
 * caller via `className`.
 */
export function StatusPill({ children, className = '', gap = false }: StatusPillProps) {
  const base = gap
    ? 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium'
    : 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
  return <span className={`${base} ${className}`}>{children}</span>;
}
