// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Search, X } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';
import { FilterInput } from './FilterInput';

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  /** Current search text. */
  value: string;
  /** Called with the new text (already unwrapped from the event). */
  onChange: (value: string) => void;
  /** When provided, a clear (✕) button shows while `value` is non-empty. */
  onClear?: () => void;
  /** Extra classes for the relative wrapper (e.g. width constraints). */
  containerClassName?: string;
}

/**
 * Search box = leading magnifier icon + the kit `FilterInput` (+ optional clear
 * button). Replaces the hand-rolled `relative > Search + input` triplet repeated
 * across the list pages so every search field looks and behaves identically.
 */
export function SearchInput({
  value,
  onChange,
  onClear,
  placeholder = 'Search…',
  containerClassName = '',
  className = '',
  ...rest
}: SearchInputProps) {
  const showClear = !!onClear && value.length > 0;
  return (
    <div className={`relative ${containerClassName}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
      <FilterInput
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`pl-9${showClear ? ' pr-8' : ''}${className ? ` ${className}` : ''}`}
        {...rest}
      />
      {showClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
