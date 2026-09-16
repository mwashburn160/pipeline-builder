// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Fragment } from 'react';
import { Card } from '@/components/ui/Card';
import { HelpAccordionTopic } from './HelpAccordionTopic';
import { MATCH_LABEL, type HelpSearchResult } from '@/lib/help/search';

/**
 * Split `text` on each case-insensitive occurrence of `term` and wrap the hits
 * in <mark>. Done here rather than with dangerouslySetInnerHTML so the corpus
 * (which includes user-facing code samples) can never inject markup.
 */
function Highlighted({ text, term }: { text: string; term: string }) {
  const q = term.trim();
  if (!q) return <>{text}</>;
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  let key = 0;
  for (;;) {
    const hit = lower.indexOf(needle, at);
    if (hit < 0) break;
    if (hit > at) out.push(<Fragment key={key++}>{text.slice(at, hit)}</Fragment>);
    out.push(
      <mark key={key++} className="bg-amber-200 dark:bg-amber-500/40 text-inherit rounded-sm px-0.5">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    at = hit + q.length;
  }
  out.push(<Fragment key={key++}>{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

interface HelpSearchResultCardProps {
  result: HelpSearchResult;
  query: string;
  /** Expand the full topic body inline. Applied to the top hit. */
  defaultOpen?: boolean;
}

/**
 * One search hit: the evidence (which sections matched, with highlighted
 * snippets) sitting directly above the full topic accordion.
 *
 * The evidence is the point. Before this, a search rendered the same collapsed
 * accordion as the browse view, so "2 of 18 topics" told the reader a match
 * existed somewhere inside a topic that can run to thousands of lines, without
 * saying where — the snippets answer that without making them expand anything.
 */
export function HelpSearchResultCard({ result, query, defaultOpen = false }: HelpSearchResultCardProps) {
  const { topic, sections, sectionCount, where } = result;
  const hidden = sectionCount - sections.length;

  return (
    <Card className="p-0 overflow-hidden">
      {/* Re-mount the accordion whenever the query changes so a new search
          re-applies defaultOpen — the accordion holds its own open state. */}
      <HelpAccordionTopic key={`${topic.id}:${query}`} topic={topic} defaultOpen={defaultOpen} bare />

      {sections.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-800/30 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {sectionCount} matching {sectionCount === 1 ? 'section' : 'sections'}
            <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400 dark:text-gray-500">
              · matched {MATCH_LABEL[where]}
            </span>
          </p>
          <ul className="mt-2 space-y-2">
            {/* Section ids aren't unique within a generated topic (two `overview`s). */}
            {sections.map(({ section, snippet }, i) => (
              <li key={`${section.id}:${i}`} className="text-xs leading-relaxed">
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  <Highlighted text={section.title} term={query} />
                </span>
                <span className="text-gray-400 dark:text-gray-500"> — </span>
                <span className="text-gray-600 dark:text-gray-400">
                  <Highlighted text={snippet} term={query} />
                </span>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
              +{hidden} more {hidden === 1 ? 'section' : 'sections'} match — expand the topic to read them.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
