// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SelectHTMLAttributes, ReactNode } from 'react';

interface FilterSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}

/**
 * Typed wrapper over the `.filter-select` CSS layer — the compact filter-bar
 * select hand-repeated across the advanced-filter panels. Kit counterpart to
 * `Select`; merges extra `className`.
 */
export function FilterSelect({ className = '', children, ...props }: FilterSelectProps) {
  return (
    <select className={['filter-select', className].filter(Boolean).join(' ')} {...props}>
      {children}
    </select>
  );
}
