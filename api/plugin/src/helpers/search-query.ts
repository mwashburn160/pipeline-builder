// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The stored form of a directory search query: trimmed, lowercase, inner whitespace collapsed, ≤ 200 chars. */
export function normalizeSearchQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}
