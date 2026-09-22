// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure ranking for the AI generator's "similar plugins already exist" hint.
 * Given the catalog rows the caller can see and the
 * user's prompt, pick the few plugins that look most like what the user is
 * asking for, so the model can be told not to duplicate them and the UI can
 * point the user at them instead.
 *
 * Scoring is plain token overlap, weighted by where the token matched:
 * name > keywords > category > summary/description. No I/O here; the query
 * lives in `services/similar-plugin-lookup.ts`.
 */

/** A catalog row as the lookup query selects it. */
export interface SimilarPluginCandidate {
  id: string;
  name: string;
  version: string;
  category: string | null;
  summary: string | null;
  description: string | null;
  keywords: unknown;
  /** The listed version's health score, when the row is published to a listing: equal matches favour the healthier plugin. */
  healthScore?: number | null;
}

/** One entry of the `similarPlugins` hint returned to the caller. */
export interface SimilarPlugin {
  id: string;
  name: string;
  version: string;
  category: string | null;
  /** The card one-liner, or a truncated description when there is none. */
  summary: string | null;
  keywords: string[];
}

/** Maximum number of similar plugins surfaced. */
export const MAX_SIMILAR_PLUGINS = 5;

/** Maximum length of the `summary` returned (and rendered into the prompt). */
export const SIMILAR_SUMMARY_MAX = 160;

const WEIGHT_NAME = 5;
const WEIGHT_KEYWORD = 3;
const WEIGHT_CATEGORY = 2;
const WEIGHT_TEXT = 1;

/**
 * Minimum score to count as "similar". A single description-only hit (weight
 * 1) is noise; anything touching the name, keywords or category — or two
 * description hits — qualifies.
 */
const MIN_SCORE = 2;

/** Words that carry no signal about WHICH plugin the user wants. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'create', 'do', 'for', 'from', 'generate',
  'i', 'in', 'into', 'is', 'it', 'its', 'make', 'me', 'my', 'need', 'new', 'of', 'on', 'or', 'our', 'plugin',
  'plugins', 'should', 'step', 'that', 'the', 'then', 'this', 'to', 'use', 'using', 'want', 'we', 'which',
  'with', 'will', 'would', 'you',
]);

/** Lowercase alphanumeric tokens of `text`, minus stopwords and 1-char noise. */
export function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 1 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** The keywords column is JSONB — accept only an array of strings. */
function keywordList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];
}

/** Collapse whitespace/control characters and cap the length. */
function shorten(text: string | null, max: number): string | null {
  if (!text) return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flat = text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Count how many of `set`'s tokens appear in `promptTokens`. */
function overlap(promptTokens: Set<string>, set: Set<string>): number {
  let n = 0;
  for (const t of set) if (promptTokens.has(t)) n++;
  return n;
}

/** Score one candidate against the prompt tokens. */
export function scoreCandidate(promptTokens: Set<string>, c: SimilarPluginCandidate): number {
  const keywordTokens = new Set<string>();
  for (const k of keywordList(c.keywords)) for (const t of tokenize(k)) keywordTokens.add(t);
  const textTokens = new Set([...tokenize(c.summary), ...tokenize(c.description)]);
  return overlap(promptTokens, tokenize(c.name)) * WEIGHT_NAME
    + overlap(promptTokens, keywordTokens) * WEIGHT_KEYWORD
    + overlap(promptTokens, tokenize(c.category)) * WEIGHT_CATEGORY
    + overlap(promptTokens, textTokens) * WEIGHT_TEXT;
}

/**
 * Rank `candidates` by similarity to `prompt` and return the top `limit`.
 *
 * `candidates` must already exclude deprecated/yanked/deleted rows and be
 * ordered so the preferred version of each plugin (own org first, then the
 * default, then the highest semver) comes FIRST for its name: only the first
 * row per name is considered. Ties keep that input order.
 */
/** Health as a tie-breaker: unknown ranks below any score. */
const health = (c: SimilarPluginCandidate): number => (typeof c.healthScore === 'number' ? c.healthScore : -1);

export function rankSimilarPlugins(
  prompt: string,
  candidates: readonly SimilarPluginCandidate[],
  limit: number = MAX_SIMILAR_PLUGINS,
): SimilarPlugin[] {
  const promptTokens = tokenize(prompt);
  if (promptTokens.size === 0 || limit <= 0) return [];

  const seen = new Set<string>();
  const scored: Array<{ c: SimilarPluginCandidate; score: number; order: number }> = [];
  candidates.forEach((c, order) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    const score = scoreCandidate(promptTokens, c);
    if (score >= MIN_SCORE) scored.push({ c, score, order });
  });

  return scored
    .sort((a, b) => b.score - a.score || health(b.c) - health(a.c) || a.order - b.order)
    .slice(0, limit)
    .map(({ c }) => ({
      id: c.id,
      name: c.name,
      version: c.version,
      category: c.category,
      summary: shorten(c.summary, SIMILAR_SUMMARY_MAX) ?? shorten(c.description, SIMILAR_SUMMARY_MAX),
      keywords: keywordList(c.keywords).slice(0, 10),
    }));
}
