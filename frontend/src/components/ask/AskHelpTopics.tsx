// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { BookOpen, Clock, Search, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/Skeleton';
import { HelpSearchResultCard } from '@/components/help/HelpSearchResult';
import { HelpTopicGroup } from '@/components/help/HelpTopicGroup';
import { useHelpSearch } from '@/lib/help/use-help-search';

/** Why the panel is showing topics instead of the question box. */
export interface AskHelpTopicsProps {
  /**
   * The explanation to show above the topics, already a full sentence. Absent
   * when the deployment simply runs in `help-topics` mode, where there is no
   * outage to explain and a notice would only add noise.
   */
  notice?: string;
  /** `scheduled-off` is temporary and says when it returns; the rest are not. */
  temporary?: boolean;
  /** Closes the drawer when the reader leaves for the full help page. */
  onClose: () => void;
}

/**
 * Help topics rendered INSIDE the Ask drawer.
 *
 * Shown in two situations, which read differently to the user and so are
 * distinguished by `notice`:
 *
 *   1. `ASK_UI_MODE=help-topics` — the deployment never offers the agent. No
 *      notice: nothing is wrong, and saying "the assistant is unavailable"
 *      about a deliberate configuration invites a support ticket.
 *   2. The agent is enabled but cannot answer right now — its self-hosted model
 *      is outside its business-hours window, or no provider is configured.
 *      `GET /ask/availability` supplies the sentence, which already states
 *      times as UTC and, when the schedule is the cause, when it returns.
 *
 * The corpus is ~1 MB of generated source behind a dynamic import, so it is
 * fetched on mount rather than imported at module scope — the drawer paints its
 * search box immediately and the topics arrive into skeletons. This component
 * is only ever reached from the lazily-loaded AskPanel, so neither the corpus
 * nor this file touches the signed-out landing page's chunk.
 */
export function AskHelpTopics({ notice, temporary, onClose }: AskHelpTopicsProps) {
  const [query, setQuery] = useState('');
  // The same corpus load, search and miss reporting the Help page runs — a
  // reader who lands here because the assistant is off is exactly whose unmet
  // searches matter, so the two must count them identically.
  const { groups, results, searching } = useHelpSearch(query);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {notice && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-default bg-surface-muted px-3 py-2 text-sm text-fg-muted">
          {temporary
            ? <Clock className="w-4 h-4 mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            : <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-fg-subtle" aria-hidden="true" />}
          <span>{notice}</span>
        </div>
      )}

      {/* A plain input rather than HelpSearchBox: that one reports topic,
          result and section counts across a full-width page, which does not
          fit a drawer and is not what someone reaching for help here needs. */}
      <label className="relative block">
        <span className="sr-only">Search help topics</span>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help topics…"
          className="w-full rounded-lg border border-default bg-surface pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </label>

      <div className="mt-3 flex-1 min-h-0 overflow-y-auto space-y-3">
        {groups === null
          ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)
          : searching
            ? (results.length === 0
              ? (
                <p className="py-8 text-center text-sm text-fg-muted">
                  Nothing matches <span className="font-medium">&quot;{query}&quot;</span>.
                </p>
              )
              : results.map((result, i) => (
                <HelpSearchResultCard
                  key={result.topic.id}
                  result={result}
                  query={query}
                  defaultOpen={i === 0}
                />
              )))
            : groups.map((group, gi) => (
              <HelpTopicGroup
                key={group.category}
                category={group.category}
                topics={group.topics}
                openFirst={gi === 0}
              />
            ))}
      </div>

      <div className="mt-3 pt-3 border-t border-default flex items-center justify-between text-xs text-fg-muted">
        <span>Read-only · nothing is changed</span>
        <Link href="/dashboard/help" onClick={onClose} className="inline-flex items-center gap-1 hover:text-brand">
          <BookOpen className="w-3.5 h-3.5" /> Browse all help
        </Link>
      </div>
    </div>
  );
}
