// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Search over the help corpus.
 *
 * Extracted from pages/dashboard/help.tsx, which previously did a flat
 * `topicSearchText(topic).includes(q)` filter. That was too coarse to be useful:
 * the corpus is 18 topics but several are thousands of lines (deployment,
 * env-variables, api-reference), so "this topic matches" left the reader to find
 * the hit themselves inside a collapsed accordion. Matching at SECTION level and
 * returning a snippet is what makes the result actionable.
 *
 * Pure and dependency-free so it can be unit-tested without rendering.
 */

import type { HelpTopic, HelpSection, ContentBlock } from './types';

/** Where a match was found, best-first. Drives both ranking and the UI label. */
export type MatchField = 'title' | 'description' | 'section' | 'body';

export interface SectionMatch {
  section: HelpSection;
  /** A short excerpt of the section text centred on the first hit. */
  snippet: string;
  where: Extract<MatchField, 'section' | 'body'>;
}

export interface HelpSearchResult {
  topic: HelpTopic;
  /** Higher sorts first. */
  score: number;
  /** Strongest field that matched, for the "matched in …" hint. */
  where: MatchField;
  /** Sections that matched, best-first. Empty when only topic metadata matched. */
  sections: SectionMatch[];
  /** Total number of matching sections (sections[] is capped for display). */
  sectionCount: number;
}

/** Max sections surfaced per topic — enough to orient, not a wall of text. */
const MAX_SECTIONS_PER_TOPIC = 4;
/** Characters of context either side of a hit. */
const SNIPPET_PAD = 70;

/** Flatten a content block to plain searchable text. */
export function blockText(block: ContentBlock): string {
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

/** All text in a section, including its title. */
export function sectionText(section: HelpSection): string {
  return [section.title, ...section.blocks.map(blockText)].join(' ');
}

/**
 * Build an excerpt centred on the first occurrence of `q`, with ellipses where
 * text was trimmed. Whitespace is collapsed first so multi-line code blocks and
 * markdown tables don't produce a ragged snippet.
 */
export function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q);
  if (at < 0) return flat.slice(0, SNIPPET_PAD * 2).trim();
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(flat.length, at + q.length + SNIPPET_PAD);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/**
 * Rank one topic against a lowercased query. Returns null when nothing matches.
 *
 * Scoring is deliberately simple and stable: a title hit always outranks a body
 * hit, and among equal fields more matching sections wins. There is no fuzzy
 * matching — the corpus is small and exact substring keeps results predictable.
 */
function scoreTopic(topic: HelpTopic, q: string): HelpSearchResult | null {
  const inTitle = topic.title.toLowerCase().includes(q);
  const inDescription = topic.description.toLowerCase().includes(q);

  const sections: SectionMatch[] = [];
  for (const section of topic.sections) {
    const titleHit = section.title.toLowerCase().includes(q);
    const body = section.blocks.map(blockText).join(' ');
    const bodyHit = body.toLowerCase().includes(q);
    if (!titleHit && !bodyHit) continue;
    sections.push({
      section,
      where: titleHit ? 'section' : 'body',
      snippet: snippetAround(titleHit ? sectionText(section) : body, q),
    });
  }

  if (!inTitle && !inDescription && sections.length === 0) return null;

  // Section-title hits before body hits, otherwise original document order.
  sections.sort((a, b) => (a.where === b.where ? 0 : a.where === 'section' ? -1 : 1));

  const where: MatchField = inTitle
    ? 'title'
    : inDescription
      ? 'description'
      : sections[0].where;

  const base = inTitle ? 1000 : inDescription ? 500 : sections[0].where === 'section' ? 250 : 100;
  return {
    topic,
    where,
    score: base + sections.length,
    sections: sections.slice(0, MAX_SECTIONS_PER_TOPIC),
    sectionCount: sections.length,
  };
}

/**
 * Search the corpus. An empty/whitespace query returns [] — the caller is
 * expected to show the browse view instead, not "every topic as a result".
 */
export function searchHelp(topics: readonly HelpTopic[], query: string): HelpSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return topics
    .map((t) => scoreTopic(t, q))
    .filter((r): r is HelpSearchResult => r !== null)
    .sort((a, b) => b.score - a.score);
}

/** Human label for where a hit was found, used in the result row. */
export const MATCH_LABEL: Record<MatchField, string> = {
  title: 'in title',
  description: 'in summary',
  section: 'in section heading',
  body: 'in content',
};
