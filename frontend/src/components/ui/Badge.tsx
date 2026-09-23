import type { ReactNode } from 'react';

/**
 * THE status→colour vocabulary. One token set, declared once.
 *
 * Every status map in the app resolves to one of these — the `src/lib/*` maps
 * (ecosystem, advisories, plugin-reviews, plugin-submissions, compliance) and
 * the per-surface ones alike. Before this it was re-declared verbatim in five
 * files and bypassed by raw Tailwind pairs in a sixth, and the drift was
 * user-visible: `pending` was blue on one page and yellow on another.
 *
 * Conventions, so a new status picks itself: `green` = done/healthy,
 * `red` = failed/blocked, `yellow` = waiting on someone, `blue` = informational,
 * `gray` = inert (expired, withdrawn, cancelled), `purple`/`indigo` = elevated
 * or second-stage states with no semantic token of their own.
 */
export type BadgeColor = 'green' | 'red' | 'gray' | 'blue' | 'purple' | 'yellow' | 'indigo';

/** Props for the Badge component. */
interface BadgeProps {
  /** Badge label content */
  children: ReactNode;
  /** Color variant controlling background and text styling */
  color: BadgeColor;
  /** Additional CSS classes */
  className?: string;
}

// The four status colours ride the `--pb-*` tokens, so a badge re-resolves with
// the theme instead of carrying a light/dark class pair. `purple` / `indigo`
// have no semantic token (the set is brand + success/warning/danger/info) and
// stay on the raw palette; `gray` is the neutral surface pair.
const colorStyles = {
  green: 'bg-success-bg text-success-strong',
  red: 'bg-danger-bg text-danger-strong',
  gray: 'bg-surface-muted text-fg-muted',
  blue: 'bg-info-bg text-info-strong',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  yellow: 'bg-warning-bg text-warning-strong',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
};

/** Small colored pill badge for displaying status labels or categories. */
export function Badge({ children, color, className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorStyles[color]} ${className}`}>
      {children}
    </span>
  );
}
