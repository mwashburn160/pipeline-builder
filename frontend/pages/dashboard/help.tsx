// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, Sparkles, X, CornerDownLeft } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { HelpAccordionTopic } from '@/components/help/HelpAccordionTopic';
import { HelpSearchResultCard } from '@/components/help/HelpSearchResult';
import { HELP_TOPICS, HELP_GROUPS } from '@/lib/help';
import { WHATS_NEW } from '@/lib/help/whats-new';
import { searchHelp } from '@/lib/help/search';

/** Suggested queries for the idle state — cheap orientation into a 18-topic corpus. */
const SUGGESTIONS = ['aws ses', 'env variables', 'register a plugin', 'compliance', 'cli'];

export default function HelpPage() {
  const { user, isReady } = useAuthGuard();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchHelp(HELP_TOPICS, query), [query]);
  const searching = query.trim().length > 0;
  const totalSections = useMemo(
    () => results.reduce((n, r) => n + r.sectionCount, 0),
    [results],
  );

  // `/` focuses search from anywhere on the page, Escape clears it. Both are
  // skipped while the user is typing in another field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === 'Escape' && el === inputRef.current) {
        setQuery('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Help" subtitle="Guides, references, and what's new">
      {/* `items-start` is load-bearing: these two cards share a grid row, and a
          stretched search card (three lines of content next to a five-entry
          feed) rendered as a tall empty box with the results pushed below the
          fold — the single worst thing about the previous layout. */}
      <div className="max-w-5xl grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5 items-start">
        <Card className="lg:col-span-2">
          <label htmlFor="help-search" className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
            <Search className="w-4 h-4 text-gray-400" />
            Search the docs
          </label>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              id="help-search"
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Try "aws ses" or "register a plugin"…'
              className="filter-input pl-10 pr-9 w-full"
              autoFocus
              aria-describedby="help-search-status"
            />
            {searching ? (
              <button
                type="button"
                onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-block text-[10px] font-mono text-gray-400 dark:text-gray-500 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5">
                /
              </kbd>
            )}
          </div>

          <p id="help-search-status" aria-live="polite" className="mt-2 text-xs text-gray-500 dark:text-gray-400 min-h-[1rem]">
            {searching
              ? results.length === 0
                ? <>No matches for <span className="font-medium text-gray-700 dark:text-gray-300">&quot;{query}&quot;</span> — try a broader term.</>
                : <>{results.length} of {HELP_TOPICS.length} topics · {totalSections} matching {totalSections === 1 ? 'section' : 'sections'}</>
              : <>{HELP_TOPICS.length} topics. Press <kbd className="font-mono">/</kbd> to search, <kbd className="font-mono">Esc</kbd> to clear.</>}
          </p>

          {!searching && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-gray-400 dark:text-gray-500">Popular:</span>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setQuery(s); inputRef.current?.focus(); }}
                  className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber-500" />
            What&apos;s new
          </h2>
          <ul className="mt-2 space-y-2 text-xs">
            {WHATS_NEW.map((entry) => (
              <li key={entry.title} className="border-l-2 border-amber-300 dark:border-amber-700 pl-2">
                <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                  <span>{entry.when}</span>
                  <span className="text-gray-400 dark:text-gray-500 font-mono normal-case tracking-normal">· {entry.date}</span>
                </div>
                <div className="text-gray-800 dark:text-gray-200">
                  {entry.href
                    ? <Link href={entry.href} className="action-link">{entry.title}</Link>
                    : entry.title}
                </div>
                {entry.hint && <div className="text-gray-500 dark:text-gray-400">{entry.hint}</div>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* RESULTS view — replaces the category browse entirely while searching,
          so the answer is the first thing below the input rather than something
          to scroll for. */}
      {searching ? (
        <div className="space-y-3 max-w-5xl">
          {results.length === 0 ? (
            <Card className="text-center py-12">
              <Search className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600" />
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">
                Nothing matches <span className="font-medium">&quot;{query}&quot;</span>.
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Search covers titles, section headings, body text, code samples and table cells.
              </p>
              <button
                type="button"
                onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                className="mt-4 text-xs action-link inline-flex items-center gap-1"
              >
                <CornerDownLeft className="w-3 h-3" /> Back to all topics
              </button>
            </Card>
          ) : (
            results.map((result, i) => (
              <HelpSearchResultCard
                key={result.topic.id}
                result={result}
                query={query}
                defaultOpen={i === 0}
              />
            ))
          )}
        </div>
      ) : (
        /* BROWSE view — the category index. */
        <div className="space-y-6 max-w-5xl">
          {HELP_GROUPS.map((group, gi) => (
            <section key={group.category} className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {group.category}
                <span className="ml-2 font-normal normal-case tracking-normal text-gray-400 dark:text-gray-500">
                  {group.topics.length} {group.topics.length === 1 ? 'topic' : 'topics'}
                </span>
              </h2>
              {group.topics.map((topic, ti) => (
                <HelpAccordionTopic key={topic.id} topic={topic} defaultOpen={gi === 0 && ti === 0} />
              ))}
            </section>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
