// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RangeKey } from '@/hooks/useObservabilityQuery';

interface RangePickerProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}

const PRESETS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: '1h', label: 'Last 1h' },
  { key: '6h', label: 'Last 6h' },
  { key: '24h', label: 'Last 24h' },
];

/**
 * Three preset time-range buttons. Custom datetime input is intentionally
 * not in v1 (see plan's Non-goals). The chosen value is meant to be
 * URL-encoded by the page so refresh/back preserves the selection.
 */
export function RangePicker({ value, onChange }: RangePickerProps) {
  return (
    <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden">
      {PRESETS.map((p, i) => {
        const active = p.key === value;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.key)}
            className={`px-3 py-1.5 text-xs font-medium ${i > 0 ? 'border-l border-gray-300 dark:border-gray-600' : ''} ${
              active
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
            aria-pressed={active}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
