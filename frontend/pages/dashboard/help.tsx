// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Sparkles } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { HelpAccordionTopic } from '@/components/help/HelpAccordionTopic';
import { HELP_TOPICS, HELP_GROUPS } from '@/lib/help';
import type { HelpTopic, ContentBlock } from '@/lib/help/types';

/**
 * Lightweight "what's new" feed. Hard-coded here for now — the entries
 * mirror the recent shipped capabilities the dashboard surfaces. When a
 * proper changelog endpoint exists, swap this for an api fetch.
 *
 * Each entry should reference a destination page so users can try the
 * feature directly. Keep the list short (top 5) and recent.
 */
// Each entry carries an ISO `date` for at-a-glance staleness. `when` is a
// human-readable bucket; both are surfaced so reviewers can see what's
// genuinely fresh vs. carried over from previous sprints.
const WHATS_NEW: ReadonlyArray<{ when: string; date: string; title: string; href?: string; hint?: string }> = [
  { when: 'This week', date: '2026-05-28', title: 'Read-only "view as user" impersonation for sysadmins', href: '/dashboard/users', hint: 'Reproduce a tenant\'s view safely; writes blocked under impersonation.' },
  { when: 'This week', date: '2026-05-27', title: 'Notifications & alert-channel preferences', href: '/dashboard/notifications' },
  { when: 'This week', date: '2026-05-26', title: 'Executions drill-down with CSV export', href: '/dashboard/executions' },
  { when: 'Recent', date: '2026-05-15', title: 'Step-up password reverify on destructive sysadmin actions' },
  { when: 'Recent', date: '2026-05-10', title: 'Per-org KMS, IdP config, and org-tier change endpoint' },
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

  // Same filter, but keep the category grouping (drop empty groups).
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return HELP_GROUPS
      .map((g) => ({
        category: g.category,
        topics: q ? g.topics.filter((t) => topicSearchText(t).includes(q)) : g.topics,
      }))
      .filter((g) => g.topics.length > 0);
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
                <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                  <span>{entry.when}</span>
                  <span className="text-gray-400 dark:text-gray-500 font-mono normal-case tracking-normal">· {entry.date}</span>
                </div>
                <div className="text-gray-800 dark:text-gray-200">
                  {entry.href
                    ? <Link href={entry.href} className="action-link">{entry.title}</Link>
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

      <div className="space-y-6 max-w-4xl">
        {visibleGroups.map((group, gi) => (
          <section key={group.category} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {group.category}
            </h2>
            {group.topics.map((topic, ti) => (
              <HelpAccordionTopic key={topic.id} topic={topic} defaultOpen={gi === 0 && ti === 0 && !query} />
            ))}
          </section>
        ))}
        {visibleGroups.length === 0 && (
          <div className="card text-center py-10 text-sm text-gray-500 dark:text-gray-400">
            No topics match <code>&quot;{query}&quot;</code>. Clear the search or try a different term.
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
