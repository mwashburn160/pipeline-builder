// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Search-miss retention: normalized at write; the sweep prunes past the
 * window and folds repeats into one counted row, in SQL.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';

import { setupEcosystemHarness, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const misses = await import('../src/services/ecosystem/search-misses.js');
const { normalizeSearchQuery } = await import('../src/helpers/search-query.js');
await wireEcosystemHarness(h);

const dialect = new PgDialect();

beforeEach(() => { h.db.reset(); });

describe('search misses', () => {
  it('stores the query normalized', () => {
    expect(normalizeSearchQuery('  Terraform   LINT \t')).toBe('terraform lint');
    expect(normalizeSearchQuery('x'.repeat(300))).toHaveLength(200);
  });

  it('prunes rows unseen for 30 days, then folds duplicates into their newest row with the summed hits', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    h.db.execute.handler = (q) => {
      const { sql, params } = dialect.sqlToQuery(q as never);
      seen.push({ sql, params });
      return { rowCount: sql.startsWith('\n      DELETE FROM ecosystem_search_misses WHERE created_at') ? 4 : 2, rows: [] };
    };
    const now = new Date('2026-09-21T00:00:00Z');
    expect(await misses.sweepSearchMisses(now)).toEqual({ pruned: 4, folded: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.sql).toMatch(/DELETE FROM ecosystem_search_misses WHERE created_at < \$1/);
    expect(new Date(seen[0]!.params[0] as string).toISOString()).toBe('2026-08-22T00:00:00.000Z');
    expect(seen[1]!.sql).toMatch(/GROUP BY lower\(btrim\(query\)\), category\s+HAVING COUNT\(\*\) > 1/);
    expect(seen[1]!.sql).toMatch(/SET query = g\.q, hits = g\.hits, created_at = g\.last_seen/);
    expect(seen[1]!.sql).toMatch(/m\.id <> g\.keep/);
  });
});
