// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { InputHTMLAttributes } from 'react';

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Styled `<input type="checkbox">`. Bundles the `rounded border-gray-300`
 * treatment hand-pasted across the permission pickers / filter lists so the
 * raw input pattern lives in one place. All native input props pass through
 * (`checked`, `onChange`, `disabled`, `aria-*`, …).
 */
export function Checkbox({ className = '', ...props }: CheckboxProps) {
  const classes = ['rounded border-gray-300 dark:border-gray-600', className]
    .filter(Boolean).join(' ');
  return <input type="checkbox" className={classes} {...props} />;
}
