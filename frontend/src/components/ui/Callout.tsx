// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Info, AlertTriangle, CheckCircle2, XCircle, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type CalloutVariant = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

// Tinted surface + text + icon, per variant. Uses the Tailwind palette (with dark
// variants) rather than the small `--pb-*` set so each intent reads distinctly;
// mirrors the `.alert-*` intent colors. `neutral` uses the muted surface tokens.
const STYLES: Record<CalloutVariant, { box: string; icon: string; defaultIcon: LucideIcon }> = {
  info:    { box: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-200', icon: 'text-blue-500', defaultIcon: Info },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200', icon: 'text-amber-500', defaultIcon: AlertTriangle },
  success: { box: 'border-green-200 bg-green-50 text-green-900 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-200', icon: 'text-green-500', defaultIcon: CheckCircle2 },
  danger:  { box: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200', icon: 'text-red-500', defaultIcon: XCircle },
  neutral: { box: 'border-[var(--pb-border)] bg-[var(--pb-surface-muted)] text-[var(--pb-text)]', icon: 'text-[var(--pb-text-muted)]', defaultIcon: Info },
};

interface CalloutProps {
  variant?: CalloutVariant;
  /** Override the default per-variant icon. Pass `null` to hide it. */
  icon?: LucideIcon | null;
  title?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

/**
 * An inline, tinted note box (`rounded-xl`) with an icon, optional title, and
 * body. Richer than the message-only `BaseAlert` — collapses the ~8 bespoke
 * colored `<div className="rounded border bg-*">` boxes hand-rolled across the
 * settings/govern pages (seat/team banners, info notes, test results, locks).
 */
export function Callout({ variant = 'info', icon, title, children, onDismiss, className = '' }: CalloutProps) {
  const s = STYLES[variant];
  const Icon = icon === null ? null : (icon ?? s.defaultIcon);
  return (
    <div
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'note'}
      className={['flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', s.box, className].filter(Boolean).join(' ')}
    >
      {Icon && <Icon className={['mt-0.5 h-4 w-4 shrink-0', s.icon].join(' ')} />}
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children != null && <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className={['shrink-0 rounded p-0.5 hover:opacity-70', s.icon].join(' ')}>
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
