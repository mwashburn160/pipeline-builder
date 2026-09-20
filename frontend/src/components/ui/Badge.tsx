import type { ReactNode } from 'react';

/** Props for the Badge component. */
interface BadgeProps {
  /** Badge label content */
  children: ReactNode;
  /** Color variant controlling background and text styling */
  color: 'green' | 'red' | 'gray' | 'blue' | 'purple' | 'yellow' | 'indigo';
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
