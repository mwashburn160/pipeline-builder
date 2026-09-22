// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zero-result directory searches (§6a "what people look for"), kept bounded
 * (E17): the directory records each miss with its query NORMALIZED, and the
 * maintenance pass folds repeats of one (query, category) into a single row
 * counting `hits` (its `created_at` the latest occurrence), then drops rows not
 * seen for {@link SEARCH_MISS_RETENTION_DAYS} days. An anonymous caller can add
 * rows, never grow the table without bound.
 */

import { sql } from 'drizzle-orm';

import { elevated } from './store.js';

/** How long a search miss is kept after it was last seen. */
export const SEARCH_MISS_RETENTION_DAYS = 30;

const rowCount = (res: unknown): number => {
  const r = res as { rowCount?: unknown; rows?: unknown[] } | null;
  if (typeof r?.rowCount === 'number') return r.rowCount;
  return Array.isArray(r?.rows) ? r.rows.length : 0;
};

/**
 * One sweep: prune misses older than the retention window, then fold every
 * duplicate (query, category) group into its newest row with the summed hits.
 * Returns how many rows it pruned and how many duplicates it folded away.
 */
export async function sweepSearchMisses(now: Date = new Date()): Promise<{ pruned: number; folded: number }> {
  return elevated(async (tx) => {
    const cutoff = new Date(now.getTime() - SEARCH_MISS_RETENTION_DAYS * 24 * 3_600_000);
    const pruned = rowCount(await tx.execute(sql`
      DELETE FROM ecosystem_search_misses WHERE created_at < ${cutoff}`));
    // Data-modifying CTEs share one snapshot: `keep` is chosen from it, the
    // UPDATE rewrites exactly the kept rows, the DELETE removes the rest of
    // each group — never a kept row.
    const folded = rowCount(await tx.execute(sql`
      WITH groups AS (
        SELECT (array_agg(id ORDER BY created_at DESC, id DESC))[1] AS keep,
               lower(btrim(query)) AS q, category,
               SUM(hits)::int AS hits, MAX(created_at) AS last_seen
          FROM ecosystem_search_misses
         GROUP BY lower(btrim(query)), category
        HAVING COUNT(*) > 1
      ), kept AS (
        UPDATE ecosystem_search_misses m
           SET query = g.q, hits = g.hits, created_at = g.last_seen
          FROM groups g
         WHERE m.id = g.keep
        RETURNING m.id
      )
      DELETE FROM ecosystem_search_misses m
       USING groups g
       WHERE lower(btrim(m.query)) = g.q
         AND m.category IS NOT DISTINCT FROM g.category
         AND m.id <> g.keep
         AND NOT EXISTS (SELECT 1 FROM kept WHERE kept.id = m.id)
      RETURNING m.id`));
    return { pruned, folded };
  });
}
