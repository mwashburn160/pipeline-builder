// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonTone = 'default' | 'primary' | 'indigo' | 'danger' | 'warn' | 'orange' | 'success';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Hover colour tone for the icon + backdrop. */
  tone?: IconButtonTone;
  /** Required: icon-only buttons need an accessible name. */
  'aria-label': string;
  children: ReactNode;
}

// Base is a muted gray icon; the tone only drives the hover colour, matching
// the row-action pattern repeated across members/roles/etc.
const TONE_CLASS: Record<IconButtonTone, string> = {
  default: 'hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-800',
  primary: 'hover:text-blue-600 hover:bg-blue-50 dark:hover:text-blue-400 dark:hover:bg-blue-900/20',
  indigo: 'hover:text-indigo-600 hover:bg-indigo-50 dark:hover:text-indigo-400 dark:hover:bg-indigo-900/20',
  danger: 'hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-900/20',
  warn: 'hover:text-amber-600 hover:bg-amber-50 dark:hover:text-amber-400 dark:hover:bg-amber-900/20',
  orange: 'hover:text-orange-600 hover:bg-orange-50 dark:hover:text-orange-400 dark:hover:bg-orange-900/20',
  success: 'hover:text-green-600 hover:bg-green-50 dark:hover:text-green-400 dark:hover:bg-green-900/20',
};

/**
 * Compact icon-only action button (table rows, card headers). Replaces the
 * `p-1.5 rounded-lg text-gray-400 hover:text-…` class string hand-pasted ~10×
 * per page. Requires an `aria-label`.
 */
export function IconButton({ tone = 'default', type = 'button', className = '', children, ...props }: IconButtonProps) {
  const classes = ['p-1.5 rounded-lg text-gray-400 transition-colors', TONE_CLASS[tone], className]
    .filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  );
}
