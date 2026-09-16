// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { HelpSearchResultCard } from '@/components/help/HelpSearchResult';
import { HelpSearchBox } from '@/components/help/HelpSearchBox';
import { HelpTopicGroup } from '@/components/help/HelpTopicGroup';
import { WhatsNewPanel } from '@/components/help/WhatsNewPanel';
import { HELP_TOPICS, HELP_GROUPS } from '@/lib/help';
import { searchHelp } from '@/lib/help/search';

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
      {/* Two columns: search + topics stack in the main column; "What's new"
          is a sticky sidebar spanning both rows. It used to share a grid row
          with the search card, so the (taller) feed pushed the topics down and
          left a large empty gap under the search box.
          `lg:grid-rows-[auto_1fr]` keeps the spanning sidebar from stretching
          the search row. DOM order (search → feed → topics) gives phones a
          sensible stack; the feed hides there while searching so results sit
          directly under the input. */}
      <div className="max-w-7xl grid grid-cols-1 gap-4 items-start lg:grid-cols-[minmax(0,1fr)_18rem] lg:grid-rows-[auto_1fr]">
        <div className="lg:col-start-1 lg:row-start-1">
          <HelpSearchBox
            query={query}
            onQueryChange={setQuery}
            inputRef={inputRef}
            topicCount={HELP_TOPICS.length}
            resultCount={results.length}
            sectionCount={totalSections}
          />
        </div>

        <aside className={`lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-24 ${searching ? 'hidden lg:block' : ''}`}>
          <WhatsNewPanel />
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          {searching ? (
            /* RESULTS view — replaces the category browse entirely while searching. */
            <div className="space-y-3">
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
            <div className="space-y-5">
              {HELP_GROUPS.map((group, gi) => (
                <HelpTopicGroup key={group.category} category={group.category} topics={group.topics} openFirst={gi === 0} />
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
