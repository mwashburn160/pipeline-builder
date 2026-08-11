// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { InputHTMLAttributes, Ref } from 'react';

interface FilterInputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

/**
 * Typed wrapper over the `.filter-input` CSS layer — the compact filter-bar input
 * (search-icon gutter, tighter padding than `.input`) hand-repeated across the
 * advanced-filter panels. Kit counterpart to `Input`; merges extra `className`.
 */
export function FilterInput({ className = '', ...props }: FilterInputProps) {
  return <input className={['filter-input', className].filter(Boolean).join(' ')} {...props} />;
}
