// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { HelpAccordionTopic } from '@/components/help/HelpAccordionTopic';
import { HELP_TOPICS } from '@/lib/help';
import type { HelpTopic, ContentBlock } from '@/lib/help/types';

/**
 * Lightweight "what's new" feed. Hard-coded here for now — the entries
 * mirror the recent shipped capabilities the dashboard surfaces. When a
 * proper changelog endpoint exists, swap this for an api fetch.
 *
 * Each entry should reference a destination page so users can try the
 * feature directly. Keep the list short (top 5) and recent.
 */
const WHATS_NEW: ReadonlyArray<{ when: string; title: string; href?: string; hint?: string }> = [
  { when: 'This week', title: 'Read-only "view as user" impersonation for sysadmins', href: '/dashboard/users', hint: 'Reproduce a tenant\'s view safely; writes blocked under impersonation.' },
  { when: 'This week', title: 'Notifications & alert-channel preferences', href: '/dashboard/notifications' },
  { when: 'This week', title: 'Executions drill-down with CSV export', href: '/dashboard/executions' },
  { when: 'Recent', title: 'Step-up password reverify on destructive sysadmin actions' },
  { when: 'Recent', title: 'Per-org KMS, IdP config, and org-tier change endpoint' },
];

/**
 * Tokenize a help topic into a single lowercase search string. Walks
 * every block type so search hits content text, code samples, table
 * cells, and list items.
 */
function topicSearchText(topic: HelpTopic): string {
  const parts: string[] = [topic.title, topic.description];
  for (const section of topic.sections) {
    parts.push(section.title);
    for (const block of section.blocks) {
      parts.push(blockText(block));
    }
  }
  return parts.join(' ').toLowerCase();
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'code':
    case 'note':
    case 'warning':
      return block.content;
    case 'list':
      return block.items.join(' ');
    case 'table':
      return [block.headers.join(' '), ...block.rows.map((r) => r.join(' '))].join(' ');
  }
}

export default function HelpPage() {
  const { user, isReady } = useAuthGuard();
  const [query, setQuery] = useState('');

  const visibleTopics = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return HELP_TOPICS;
    return HELP_TOPICS.filter((t) => topicSearchText(t).includes(q));
  }, [query]);

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Help" subtitle="Guides, references, and what's new">
      <div className="max-w-4xl grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        {/* Search */}
        <div className="lg:col-span-2 card">
          <label htmlFor="help-search" className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
            <Search className="w-4 h-4 text-gray-400" />
            Search the docs
          </label>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              id="help-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Try "ai_generation" or "register a plugin"...'
              className="filter-input pl-10 w-full"
              autoFocus
            />
          </div>
          {query && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {visibleTopics.length === 0
                ? <>No topics match <code>&quot;{query}&quot;</code>. Try a broader term.</>
                : <>Showing {visibleTopics.length} of {HELP_TOPICS.length} topics.</>}
            </p>
          )}
        </div>

        {/* What's new */}
        <div className="card">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-amber-500" />
            What&apos;s new
          </h2>
          <ul className="mt-2 space-y-2 text-xs">
            {WHATS_NEW.map((entry) => (
              <li key={entry.title} className="border-l-2 border-amber-300 dark:border-amber-700 pl-2">
                <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  {entry.when}
                </div>
                <div className="text-gray-800 dark:text-gray-200">
                  {entry.href
                    ? <a href={entry.href} className="action-link">{entry.title}</a>
                    : entry.title}
                </div>
                {entry.hint && (
                  <div className="text-gray-500 dark:text-gray-400">{entry.hint}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="space-y-3 max-w-4xl">
        {visibleTopics.map((topic, i) => (
          <HelpAccordionTopic key={topic.id} topic={topic} defaultOpen={i === 0 && !query} />
        ))}
        {visibleTopics.length === 0 && (
          <div className="card text-center py-10 text-sm text-gray-500 dark:text-gray-400">
            No topics match <code>&quot;{query}&quot;</code>. Clear the search or try a different term.
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
