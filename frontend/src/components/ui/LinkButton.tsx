// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import type { ButtonVariant, ButtonSize } from './Button';
import { buttonClasses } from './buttonClasses';

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

/**
 * A Next `<Link>` painted with the `.btn` CSS layer. Use this for the
 * `<Link className="btn btn-secondary">` cases {@link Button} can't cover —
 * Button renders a `<button>`, so it can't be an anchor / client-side nav
 * target. Same variant/size vocabulary as Button.
 */
export function LinkButton({
  href, variant = 'primary', size = 'md', fullWidth = false, className = '', children, ...props
}: LinkButtonProps) {
  const classes = buttonClasses(variant, size, fullWidth, className);
  return (
    <Link href={href} className={classes} {...props}>
      {children}
    </Link>
  );
}
