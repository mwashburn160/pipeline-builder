// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonTone = 'default' | 'primary' | 'indigo' | 'purple' | 'danger' | 'warn' | 'orange' | 'success';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Hover colour tone for the icon + backdrop (muted-gray icon at rest). */
  tone?: IconButtonTone;
  /**
   * Colour the icon AT REST in this tone (not muted gray), with hover adding
   * only the tone's backdrop — for stateful/always-coloured actions like an
   * active toggle (`success`), or approve/reject (`success`/`danger`). When
   * set, `tone` is ignored. Pass `restTone={active ? 'success' : 'default'}`
   * for an on/off toggle.
   */
  restTone?: IconButtonTone;
  /** Required: icon-only buttons need an accessible name. */
  'aria-label': string;
  children: ReactNode;
}

// Muted-gray icon at rest; the tone only drives the HOVER colour, matching the
// row-action pattern repeated across members/roles/etc.
//
// Every tone that HAS a semantic token uses it, so the whole kit flips with the
// theme from one place. `indigo` / `purple` / `orange` keep raw palette classes
// because the token set is deliberately limited to brand + success/warning/
// danger/info — there is nothing to point them at.
const TONE_CLASS: Record<IconButtonTone, string> = {
  default: 'hover:text-fg hover:bg-surface-muted',
  primary: 'hover:text-brand hover:bg-info-bg',
  indigo: 'hover:text-indigo-600 hover:bg-indigo-50 dark:hover:text-indigo-400 dark:hover:bg-indigo-900/20',
  purple: 'hover:text-purple-600 hover:bg-purple-50 dark:hover:text-purple-400 dark:hover:bg-purple-900/20',
  danger: 'hover:text-danger hover:bg-danger-bg',
  warn: 'hover:text-warning hover:bg-warning-bg',
  orange: 'hover:text-orange-600 hover:bg-orange-50 dark:hover:text-orange-400 dark:hover:bg-orange-900/20',
  success: 'hover:text-success hover:bg-success-bg',
};

// Coloured icon AT REST + hover backdrop only (no hover text-shift) — for
// stateful/always-coloured actions (active toggle, approve/reject).
const REST_CLASS: Record<IconButtonTone, string> = {
  default: 'text-fg-subtle hover:bg-surface-muted',
  primary: 'text-info hover:bg-info-bg',
  indigo: 'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20',
  purple: 'text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20',
  danger: 'text-danger hover:bg-danger-bg',
  warn: 'text-warning hover:bg-warning-bg',
  orange: 'text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20',
  success: 'text-success hover:bg-success-bg',
};

/**
 * Compact icon-only action button (table rows, card headers). Replaces the
 * `p-1.5 rounded-lg text-fg-subtle hover:text-…` class string hand-pasted ~10×
 * per page. Requires an `aria-label`. Use `restTone` for stateful/coloured
 * actions (toggles, approve/reject); otherwise `tone` for a muted-at-rest icon.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tone = 'default', restTone, type = 'button', className = '', children, ...props },
  ref,
) {
  const colour = restTone ? REST_CLASS[restTone] : `text-fg-subtle ${TONE_CLASS[tone]}`;
  // Keyboard focus MUST be visible: this is the app's most common row action and
  // its only styling was a hover tone, so tabbing through a table moved an
  // invisible cursor. Ring token matches `.btn` (globals.css).
  const classes = [
    'p-1.5 rounded-lg transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
    colour,
    className,
  ].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={classes} {...props}>
      {children}
    </button>
  );
});
