// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ChevronUp, ChevronDown } from 'lucide-react';
import type { SortDir, SortField } from './types';

export interface SortHeaderProps {
  label: string;
  field: SortField;
  sortBy: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}

/** Sortable, keyboard-operable column header for the failed-jobs tables. */
export function SortHeader({ label, field, sortBy, sortDir, onSort }: SortHeaderProps) {
  const active = sortBy === field;
  return (
    <th scope="col"
      className="px-4 py-2.5 text-left font-medium text-fg-muted cursor-pointer select-none hover:text-fg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      onClick={() => onSort(field)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(field); } }}
      role="button"
      tabIndex={0}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 opacity-20" />
        )}
      </span>
    </th>
  );
}

