// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { buttonClasses } from './buttonClasses';
import { READ_ONLY_REASON } from './ReadOnlyNotice';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'danger-outline' | 'outline' | 'indigo' | 'purple' | 'orange' | 'link';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Colour variant → maps to the `.btn-*` classes in globals.css. */
  variant?: ButtonVariant;
  /** Size → maps to `.btn-xs/.btn-sm/.btn-lg` (`md` is the base `.btn`). */
  size?: ButtonSize;
  /** Stretch to the container width (`.btn-full`). */
  fullWidth?: boolean;
  /** Show a leading spinner and disable the button while an action is in flight. */
  loading?: boolean;
  /**
   * Read-only session (impersonation): disables the button and explains why in
   * its tooltip (`READ_ONLY_REASON`, replacing any `title`). Use it for write
   * controls instead of wiring `disabled` + `title` by hand.
   */
  readOnly?: boolean;
  children: ReactNode;
}

/**
 * Typed wrapper over the `.btn` CSS layer. Defaults `type="button"` (native
 * default is `submit`, a common footgun) and folds `loading` and `readOnly` into
 * the disabled state so callers don't repeat the spinner / read-only wiring by hand.
 */
export function Button({
  variant = 'primary', size = 'md', fullWidth = false, loading = false, readOnly = false,
  disabled, title, type = 'button', className = '', children, ...props
}: ButtonProps) {
  const classes = buttonClasses(variant, size, fullWidth, className);
  return (
    <button
      type={type}
      disabled={disabled || loading || readOnly}
      title={readOnly ? READ_ONLY_REASON : title}
      className={classes}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
