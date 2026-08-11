// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SelectHTMLAttributes, ReactNode, Ref } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
  /** React 19 passes `ref` as a regular prop; spread onto the native
   *  `<select>` so callers can type-safely grab the DOM node. */
  ref?: Ref<HTMLSelectElement>;
}

/** Typed wrapper over the `.input` CSS layer for native `<select>` controls. */
export function Select({ className = '', children, ...props }: SelectProps) {
  return (
    <select className={['input', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </select>
  );
}
