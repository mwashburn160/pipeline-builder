// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'danger-outline' | 'outline';
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
  children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  danger: 'btn-danger',
  success: 'btn-success',
  ghost: 'btn-ghost',
  'danger-outline': 'btn-danger-outline',
  outline: 'btn-outline',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'btn-xs', sm: 'btn-sm', md: '', lg: 'btn-lg',
};

/**
 * Typed wrapper over the `.btn` CSS layer. Defaults `type="button"` (native
 * default is `submit`, a common footgun) and folds `loading` into the disabled
 * state so callers don't repeat the spinner + `disabled` wiring by hand.
 */
export function Button({
  variant = 'primary', size = 'md', fullWidth = false, loading = false,
  disabled, type = 'button', className = '', children, ...props
}: ButtonProps) {
  const classes = ['btn', VARIANT_CLASS[variant], SIZE_CLASS[size], fullWidth && 'btn-full', className]
    .filter(Boolean).join(' ');
  return (
    <button type={type} disabled={disabled || loading} className={classes} {...props}>
      {loading && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
