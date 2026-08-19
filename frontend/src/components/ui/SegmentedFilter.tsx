export interface SegmentedFilterOption<V extends string> {
  value: V;
  label: string;
  /** Optional count suffix, rendered as " (N)". */
  count?: number;
}

interface SegmentedFilterProps<V extends string> {
  options: ReadonlyArray<SegmentedFilterOption<V>>;
  /** Current selection (compared as a string, matching the list-filter shape). */
  value: string;
  onChange: (value: V) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * Single-value pill filter group — the rounded-full segmented control repeated
 * across the admin list pages. Byte-identical to the previous hand-rolled
 * markup (organizations scope, discounts/promotions active-state).
 */
export function SegmentedFilter<V extends string>({ options, value, onChange, ariaLabel, className = '' }: SegmentedFilterProps<V>) {
  return (
    <div className={`inline-flex items-center gap-1${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = String(value) === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${active
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
          >
            {o.label}{o.count !== undefined ? ` (${o.count})` : ''}
          </button>
        );
      })}
    </div>
  );
}
