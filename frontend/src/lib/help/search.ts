// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Search over the help corpus.
 *
 * A flat "does this topic match" filter is too coarse to be useful: several
 * topics are thousands of lines (deployment, env-variables, api-reference), so
 * it would leave the reader to find the hit inside a collapsed accordion. Matching at SECTION level and
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
 * Fold a string to the form matching compares on: lowercase, with every run of
 * non-alphanumerics becoming a single space.
 *
 * The agent grounds with BM25 over tokens while this searched for one exact
 * substring, so the two surfaces disagreed about the same corpus: `sign-in` did
 * not match "sign in", `api/ask` did not match "api ask", and any two-word
 * query failed unless the docs happened to contain that exact run of
 * characters. Folding both sides removes the punctuation disagreement; the term
 * matching below removes the word-order one.
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The query as distinct terms, in order. An empty query yields no terms. */
export function queryTerms(query: string): string[] {
  const n = normalizeText(query);
  return n ? n.split(' ') : [];
}

/** Every term present in `text` (AND). Vacuously true for no terms. */
function matchesAll(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const n = normalizeText(text);
  return terms.every((term) => n.includes(term));
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
 * Rank one topic against the query's terms. Returns null when nothing matches.
 *
 * Scoring is deliberately simple and stable: a title hit always outranks a body
 * hit, and among equal fields more matching sections wins. Matching is on
 * normalized TERMS, all of which must be present (AND) — still not fuzzy, so
 * results stay predictable, but "sso setup" and "sign-in" now behave the way a
 * reader expects and the way the agent's own grounding already did.
 *
 * @param terms - Normalized query terms (see {@link queryTerms}).
 * @param first - The first term, used to centre snippets.
 */
function scoreTopic(topic: HelpTopic, terms: readonly string[], first: string): HelpSearchResult | null {
  const inTitle = matchesAll(topic.title, terms);
  const inDescription = matchesAll(topic.description, terms);

  const sections: SectionMatch[] = [];
  for (const section of topic.sections) {
    const titleHit = matchesAll(section.title, terms);
    const body = section.blocks.map(blockText).join(' ');
    const bodyHit = matchesAll(body, terms);
    if (!titleHit && !bodyHit) continue;
    sections.push({
      section,
      where: titleHit ? 'section' : 'body',
      snippet: snippetAround(titleHit ? sectionText(section) : body, first),
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
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  return topics
    .map((t) => scoreTopic(t, terms, terms[0]))
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
