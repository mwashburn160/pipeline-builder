// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ButtonVariant, ButtonSize } from './Button';

// Single source of truth for the `.btn` class vocabulary, shared by both
// `Button` (renders a <button>) and `LinkButton` (renders a Next <Link>). Kept
// here so adding a variant/size can't drift between the two components.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  danger: 'btn-danger',
  success: 'btn-success',
  ghost: 'btn-ghost',
  'danger-outline': 'btn-danger-outline',
  outline: 'btn-outline',
  indigo: 'btn-indigo',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'btn-xs', sm: 'btn-sm', md: '', lg: 'btn-lg',
};

/** Compose the `.btn` class string from a variant/size/fullWidth + extra classes. */
export function buttonClasses(
  variant: ButtonVariant,
  size: ButtonSize,
  fullWidth: boolean,
  className: string,
): string {
  return ['btn', VARIANT_CLASS[variant], SIZE_CLASS[size], fullWidth && 'btn-full', className]
    .filter(Boolean).join(' ');
}
