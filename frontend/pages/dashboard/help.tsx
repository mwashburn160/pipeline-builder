// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Search, CornerDownLeft } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { HelpSearchResultCard } from '@/components/help/HelpSearchResult';
import { HelpSearchBox } from '@/components/help/HelpSearchBox';
import { HelpTopicGroup } from '@/components/help/HelpTopicGroup';
import { WhatsNewPanel } from '@/components/help/WhatsNewPanel';
import { ContactSupportCard } from '@/components/help/ContactSupportCard';
import { useHelpSearch } from '@/lib/help/use-help-search';

export default function HelpPage() {
  const { user, isReady, can } = useAuthGuard();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // The topic a `#topic-<id>` link asked for. Ask citations link here, and a
  // reader can hand a colleague the URL of the thing they are reading — neither
  // worked while the page kept all of its state in `useState`.
  const [openId, setOpenId] = useState<string | undefined>(undefined);

  // Seed from the URL once the router has parsed it. `isReady` matters on a cold
  // load: query is an empty object during prerender, and seeding from that would
  // clear a `?q=` the reader arrived with.
  useEffect(() => {
    if (!router.isReady) return;
    const q = typeof router.query.q === 'string' ? router.query.q : '';
    if (q) setQuery(q);
    const hash = window.location.hash.replace(/^#topic-/, '');
    if (hash && hash !== window.location.hash) setOpenId(hash);
  }, [router.isReady, router.query.q]);

  // Mirror the search back into the URL so a result set is linkable. `replace`,
  // not `push`: typing would otherwise write one history entry per keystroke and
  // make Back unusable. `shallow` keeps it from re-running data fetching.
  useEffect(() => {
    if (!router.isReady) return;
    const current = typeof router.query.q === 'string' ? router.query.q : '';
    if (current === query) return;
    const url = { pathname: router.pathname, query: query ? { q: query } : {} };
    void router.replace(url, undefined, { shallow: true });
    // `router` is intentionally not a dependency: it changes identity on every
    // navigation and would re-enter this effect in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, router.isReady]);

  // Corpus load, search and miss reporting, shared with the Ask drawer's topics
  // view — which needs the identical five things and had its own copy of all of
  // them. The corpus stays a dynamic import inside the hook, so the page shell
  // still paints from the route chunk.
  const { groups, topics, results, searching } = useHelpSearch(query);

  // The browser cannot honour the fragment itself: the anchor does not exist
  // until the corpus chunk has arrived and rendered, which is long after the
  // initial scroll. Scroll once both the topic and its element are present.
  useEffect(() => {
    if (!openId || groups === null) return;
    document.getElementById(`topic-${openId}`)?.scrollIntoView({ block: 'start' });
  }, [openId, groups]);

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
          is a sticky sidebar spanning both rows, so the (taller) feed doesn't
          push the topics down and leave a gap under the search box.
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
            topicCount={topics.length}
            resultCount={results.length}
            sectionCount={totalSections}
          />
        </div>

        {/* The sidebar is also Help's only outbound path — "contact support"
            sits ABOVE the changelog so a stuck reader meets it first, and it
            stays visible while searching (a failed search is exactly when
            someone needs a human). */}
        <aside className="lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-24 space-y-4">
          <ContactSupportCard canMessage={can('messages:read')} />
          <div className={searching ? 'hidden lg:block' : ''}>
            <WhatsNewPanel />
          </div>
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          {searching ? (
            /* RESULTS view — replaces the category browse entirely while searching. */
            <div className="space-y-3">
              {results.length === 0 ? (
                <Card className="text-center py-12">
                  <Search className="w-8 h-8 mx-auto text-fg-subtle" />
                  <p className="mt-3 text-sm text-fg-muted">
                    Nothing matches <span className="font-medium">&quot;{query}&quot;</span>.
                  </p>
                  <p className="mt-1 text-xs text-fg-muted">
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
            /* BROWSE view — the category index. Skeletons stand in for the
               groups only until the corpus chunk lands. */
            <div className="space-y-5">
              {groups === null
                ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)
                : groups.map((group, gi) => (
                  <HelpTopicGroup
                    key={group.category}
                    category={group.category}
                    topics={group.topics}
                    openFirst={gi === 0}
                    openId={openId}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
