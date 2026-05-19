// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Escape regex metacharacters in a user-supplied string so it can be
 * safely used as a substring pattern in `$regex` Mongo queries.
 *
 * Without escaping, characters like `.`, `*`, `+`, `(`, `[`, `\` change
 * the semantics of the search (e.g., `.*` matches everything; a stray `(`
 * raises a regex syntax error and breaks the query). This isn't a SQL-style
 * injection — Mongo's regex engine doesn't allow operator-level injection
 * — but it is a search-correctness + ReDoS vector if the user controls
 * the pattern.
 *
 * Mirrors lodash.escapeRegExp; inlined here to avoid pulling lodash into
 * the platform bundle for a 10-line helper.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
