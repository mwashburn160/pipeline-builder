import { type LucideIcon } from 'lucide-react';
import { Button } from './Button';

interface EmptyStateProps {
  /** Glyph in the illustration circle. Omit for a text-only state. */
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Arbitrary call-to-action (a `LinkButton`, a pair of buttons, …). */
  action?: React.ReactNode;
  /** Shorthand for the common single-button CTA: renders a primary `Button`
   *  labelled `actionLabel` that calls `onAction`. Ignored when `action` is set. */
  actionLabel?: string;
  onAction?: () => void;
  illustration?: IllustrationType;
  /**
   * Smaller, unanimated form for an empty panel INSIDE a card or tab (a list
   * with no rows, a chart with no data) — where the full-page hero with its
   * glow and 64px of padding would dwarf the surface around it.
   */
  compact?: boolean;
  className?: string;
}

type IllustrationType = 'default' | 'pipelines' | 'plugins' | 'messages' | 'search';

// Each illustration is a tinted disc behind the icon. The three that map onto a
// semantic intent use the `--pb-*` tokens (one class each instead of a
// light/dark pair); `plugins` keeps purple, for which the token set — brand plus
// success/warning/danger/info — has no equivalent.
const illustrationColors: Record<IllustrationType, { bg: string; icon: string; ring: string }> = {
  default: {
    bg: 'bg-surface-muted',
    icon: 'text-fg-subtle',
    ring: '',
  },
  pipelines: {
    bg: 'bg-info-bg',
    icon: 'text-info',
    ring: 'ring-4 ring-info-border/50',
  },
  plugins: {
    bg: 'bg-purple-50 dark:bg-purple-900/20',
    icon: 'text-purple-400 dark:text-purple-500',
    ring: 'ring-4 ring-purple-100/50 dark:ring-purple-900/30',
  },
  messages: {
    bg: 'bg-success-bg',
    icon: 'text-success',
    ring: 'ring-4 ring-success-border/50',
  },
  search: {
    bg: 'bg-warning-bg',
    icon: 'text-warning',
    ring: 'ring-4 ring-warning-border/50',
  },
};

/**
 * Minimal text-only empty state.
 *
 * Renders the exact `<div>` + class string that was previously hand-rolled
 * across the compliance components, so migrating a call site produces
 * byte-identical DOM. For a richer icon/illustration empty state, use
 * {@link EmptyState} instead.
 */
export function TextEmptyState({ children }: { children: React.ReactNode }) {
  return <div className="text-center py-8 text-fg-muted">{children}</div>;
}

export function EmptyState({
  icon: Icon, title, description, action, actionLabel, onAction,
  illustration = 'default', compact = false, className = '',
}: EmptyStateProps) {
  const colors = illustrationColors[illustration];
  const cta = action ?? (actionLabel && onAction ? (
    <Button size={compact ? 'sm' : 'md'} onClick={onAction}>{actionLabel}</Button>
  ) : null);

  if (compact) {
    return (
      <div className={`text-center py-8 px-4 ${className}`}>
        {Icon && (
          <div className={`mx-auto w-10 h-10 rounded-full ${colors.bg} flex items-center justify-center mb-3`}>
            <Icon className={`w-5 h-5 ${colors.icon}`} aria-hidden="true" />
          </div>
        )}
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="mt-1 text-sm text-fg-muted max-w-sm mx-auto">{description}</p>}
        {cta && <div className="mt-4">{cta}</div>}
      </div>
    );
  }

  // The entrance is CSS (`.empty-state-reveal`), not framer-motion: it is a
  // fade plus a 10px rise with no exit, and this component is reachable from
  // every list in the app. The reduced-motion block in globals.css collapses it
  // like every other animation there.
  return (
    <div className={`empty-state-reveal relative text-center py-16 overflow-hidden ${className}`}>
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute -top-10 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full opacity-70 blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(15,111,255,0.25) 0%, rgba(15,111,255,0) 70%)' }}
        />
        <div
          className="absolute bottom-0 left-1/4 h-32 w-32 -translate-x-1/2 rounded-full opacity-60 blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(239,182,76,0.3) 0%, rgba(239,182,76,0) 70%)' }}
        />
      </div>
      {Icon && (
        <div
          className={`empty-state-glyph mx-auto w-20 h-20 rounded-full ${colors.bg} ${colors.ring} flex items-center justify-center mb-5 transition-colors`}
        >
          <Icon className={`w-9 h-9 ${colors.icon}`} aria-hidden="true" />
        </div>
      )}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1.5 text-sm text-fg-muted max-w-sm mx-auto">{description}</p>}
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  );
}
