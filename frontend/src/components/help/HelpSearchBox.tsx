// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';

/** Suggested queries for the idle state — cheap orientation into the topic corpus. */
const SUGGESTIONS = ['aws ses', 'env variables', 'register a plugin', 'compliance', 'cli'];

interface HelpSearchBoxProps {
  query: string;
  onQueryChange: (query: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  topicCount: number;
  /** Matching topics / sections — only meaningful while a query is present. */
  resultCount: number;
  sectionCount: number;
}

/** Search input + live status line + popular-query chips for the Help page. */
export function HelpSearchBox({ query, onQueryChange, inputRef, topicCount, resultCount, sectionCount }: HelpSearchBoxProps) {
  const searching = query.trim().length > 0;
  const setAndFocus = (next: string) => { onQueryChange(next); inputRef.current?.focus(); };

  return (
    <Card>
      <label htmlFor="help-search" className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
        <Search className="w-4 h-4 text-fg-subtle" />
        Search the docs
      </label>
      <div className="relative mt-2">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle pointer-events-none" />
        <input
          id="help-search"
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder='Try "aws ses" or "register a plugin"…'
          className="filter-input pl-10 pr-9 w-full"
          autoFocus
          aria-describedby="help-search-status"
        />
        {searching ? (
          <button
            type="button"
            onClick={() => setAndFocus('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-fg-subtle hover:text-fg hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="w-4 h-4" />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-block text-2xs font-mono text-fg-subtle border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5">
            /
          </kbd>
        )}
      </div>

      {/* Status and popular queries share one wrapping row so the card stays
          compact — the topics start right under it. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p id="help-search-status" aria-live="polite" className="text-xs text-fg-muted">
          {searching
            ? resultCount === 0
              ? <>No matches for <span className="font-medium text-gray-700 dark:text-gray-300">&quot;{query}&quot;</span> — try a broader term.</>
              : <>{resultCount} of {topicCount} topics · {sectionCount} matching {sectionCount === 1 ? 'section' : 'sections'}</>
            : <>{topicCount} topics. Press <kbd className="font-mono">/</kbd> to search, <kbd className="font-mono">Esc</kbd> to clear.</>}
        </p>

        {!searching && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-fg-subtle">Popular:</span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setAndFocus(s)}
                className="text-2xs px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
