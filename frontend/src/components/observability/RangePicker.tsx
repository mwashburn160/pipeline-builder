// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RangeKey } from '@/types/observability';

interface RangePickerProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}

/**
 * The button for each window, keyed off `RangeKey` so a window added to the
 * union is a COMPILE ERROR here. It was a plain array, which is why the union
 * carried a "keep in sync with the RangePicker preset list" comment: an added
 * key type-checked and simply had no button.
 */
const PRESET_LABELS: Record<RangeKey, string> = {
  '1h': 'Last 1h',
  '6h': 'Last 6h',
  '24h': 'Last 24h',
};

const PRESETS: ReadonlyArray<{ key: RangeKey; label: string }> =
  (Object.keys(PRESET_LABELS) as RangeKey[]).map((key) => ({ key, label: PRESET_LABELS[key] }));

/**
 * Three preset time-range buttons; no custom datetime input. The chosen value is meant to be
 * URL-encoded by the page so refresh/back preserves the selection.
 */
export function RangePicker({ value, onChange }: RangePickerProps) {
  return (
    <div className="inline-flex rounded-md border border-default overflow-hidden">
      {PRESETS.map((p, i) => {
        const active = p.key === value;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.key)}
            className={`px-3 py-1.5 text-xs font-medium ${i > 0 ? 'border-l border-default' : ''} ${
              active
                ? 'bg-brand text-white'
                : 'bg-surface text-fg-muted hover:bg-surface-muted'
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
