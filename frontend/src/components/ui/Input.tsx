// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** `lg` applies the `.input-lg` sizing. */
  inputSize?: 'md' | 'lg';
}

/**
 * Typed wrapper over the `.input` CSS layer. Merges any extra `className` last,
 * so it composes with `FormField` (which injects `input-error`/`input-success`
 * and the `id`/`aria-*` wiring by cloning its child).
 */
export function Input({ inputSize = 'md', className = '', ...props }: InputProps) {
  const classes = ['input', inputSize === 'lg' && 'input-lg', className].filter(Boolean).join(' ');
  return <input className={classes} {...props} />;
}
