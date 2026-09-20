// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Info, AlertTriangle, CheckCircle2, XCircle, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type CalloutVariant = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

// Tinted surface + text + icon, per variant — the `--pb-*` status tokens, which
// carry a matched border/background/foreground triple per intent and re-resolve
// per theme, so no `dark:` sibling is needed. `neutral` uses the muted surface
// tokens. Mirrors the `.alert-*` intent colors.
const STYLES: Record<CalloutVariant, { box: string; icon: string; defaultIcon: LucideIcon }> = {
  info:    { box: 'border-info-border bg-info-bg text-info-strong', icon: 'text-brand', defaultIcon: Info },
  warning: { box: 'border-warning-border bg-warning-bg text-warning-strong', icon: 'text-warning', defaultIcon: AlertTriangle },
  success: { box: 'border-success-border bg-success-bg text-success-strong', icon: 'text-success', defaultIcon: CheckCircle2 },
  danger:  { box: 'border-danger-border bg-danger-bg text-danger-strong', icon: 'text-danger', defaultIcon: XCircle },
  neutral: { box: 'border-default bg-surface-muted text-fg', icon: 'text-fg-muted', defaultIcon: Info },
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
