// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import type { ButtonVariant, ButtonSize } from './Button';

interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** Navigation target (Next `<Link href>`). */
  href: string;
  /** Colour variant → maps to the `.btn-*` classes in globals.css. */
  variant?: ButtonVariant;
  /** Size → maps to `.btn-xs/.btn-sm/.btn-lg` (`md` is the base `.btn`). */
  size?: ButtonSize;
  /** Stretch to the container width (`.btn-full`). */
  fullWidth?: boolean;
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
 * A Next `<Link>` painted with the `.btn` CSS layer. Use this for the
 * `<Link className="btn btn-secondary">` cases {@link Button} can't cover —
 * Button renders a `<button>`, so it can't be an anchor / client-side nav
 * target. Same variant/size vocabulary as Button.
 */
export function LinkButton({
  href, variant = 'primary', size = 'md', fullWidth = false, className = '', children, ...props
}: LinkButtonProps) {
  const classes = ['btn', VARIANT_CLASS[variant], SIZE_CLASS[size], fullWidth && 'btn-full', className]
    .filter(Boolean).join(' ');
  return (
    <Link href={href} className={classes} {...props}>
      {children}
    </Link>
  );
}
