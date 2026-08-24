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
const TONE_CLASS: Record<IconButtonTone, string> = {
  default: 'hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-800',
  primary: 'hover:text-blue-600 hover:bg-blue-50 dark:hover:text-blue-400 dark:hover:bg-blue-900/20',
  indigo: 'hover:text-indigo-600 hover:bg-indigo-50 dark:hover:text-indigo-400 dark:hover:bg-indigo-900/20',
  purple: 'hover:text-purple-600 hover:bg-purple-50 dark:hover:text-purple-400 dark:hover:bg-purple-900/20',
  danger: 'hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-900/20',
  warn: 'hover:text-amber-600 hover:bg-amber-50 dark:hover:text-amber-400 dark:hover:bg-amber-900/20',
  orange: 'hover:text-orange-600 hover:bg-orange-50 dark:hover:text-orange-400 dark:hover:bg-orange-900/20',
  success: 'hover:text-green-600 hover:bg-green-50 dark:hover:text-green-400 dark:hover:bg-green-900/20',
};

// Coloured icon AT REST + hover backdrop only (no hover text-shift) — for
// stateful/always-coloured actions (active toggle, approve/reject).
const REST_CLASS: Record<IconButtonTone, string> = {
  default: 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
  primary: 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20',
  indigo: 'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20',
  purple: 'text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20',
  danger: 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20',
  warn: 'text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20',
  orange: 'text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20',
  success: 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20',
};

/**
 * Compact icon-only action button (table rows, card headers). Replaces the
 * `p-1.5 rounded-lg text-gray-400 hover:text-…` class string hand-pasted ~10×
 * per page. Requires an `aria-label`. Use `restTone` for stateful/coloured
 * actions (toggles, approve/reject); otherwise `tone` for a muted-at-rest icon.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tone = 'default', restTone, type = 'button', className = '', children, ...props },
  ref,
) {
  const colour = restTone ? REST_CLASS[restTone] : `text-gray-400 ${TONE_CLASS[tone]}`;
  const classes = ['p-1.5 rounded-lg transition-colors', colour, className]
    .filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={classes} {...props}>
      {children}
    </button>
  );
});
