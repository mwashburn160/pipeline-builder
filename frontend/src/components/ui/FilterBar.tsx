import { type ReactNode } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { ActionBar } from './ActionBar';

interface FilterBarProps {
  /** Value of the primary search input */
  searchValue: string;
  /** Callback when primary search value changes */
  onSearchChange: (value: string) => void;
  /** Placeholder for the primary search input */
  searchPlaceholder?: string;
  /** Whether the advanced filter panel is open */
  showAdvanced: boolean;
  /** Toggle advanced filter panel visibility */
  onToggleAdvanced: () => void;
  /** Number of active advanced filters (shown as badge) */
  advancedFilterCount: number;
  /** Content rendered inside the collapsible advanced panel */
  advancedContent?: ReactNode;
  /** Clear all filters callback */
  onClearAll?: () => void;
  /** Summary text shown below filters when active */
  summary?: string;
}

/**
 * Reusable filter bar with primary search, collapsible advanced filters,
 * and active filter count badge. Used by pipelines, plugins, and other list pages.
 */
export function FilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  showAdvanced,
  onToggleAdvanced,
  advancedFilterCount,
  advancedContent,
  onClearAll,
  summary,
}: FilterBarProps) {
  return (
    <div className="filter-bar">
      <ActionBar
        left={
          <div className="relative min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="filter-input pl-10"
            />
          </div>
        }
        right={
          advancedContent ? (
            <button
              type="button"
              onClick={onToggleAdvanced}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                showAdvanced || advancedFilterCount > 0
                  ? 'border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              <SlidersHorizontal className="w-4 h-4" />
              Filters
              {advancedFilterCount > 0 && (
                <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold rounded-full bg-blue-600 text-white">
                  {advancedFilterCount}
                </span>
              )}
            </button>
          ) : undefined
        }
      />

      {showAdvanced && advancedContent && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap items-center gap-3">
            {advancedContent}
            {advancedFilterCount > 0 && onClearAll && (
              <button type="button" onClick={onClearAll} className="action-link-muted">
                <X className="w-3.5 h-3.5 inline mr-1" />
                Clear all
              </button>
            )}
          </div>
        </div>
      )}

      {summary && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{summary}</p>
      )}
    </div>
  );
}
