// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared `paginatedList` helper that the compliance services'
 * `list` methods route through. Locks the count+page contract: one tenant
 * transaction, `total` from the count row (0 when absent), and the row page
 * returned as `rows` for the caller to key.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let selectResults: unknown[][] = [];
let txCount = 0;

function shift(q: unknown[][]): unknown[] {
  return q.length ? (q.shift() as unknown[]) : [];
}

function makeChain(terminal: () => Promise<unknown[]>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[name] = jest.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => terminal().then(resolve);
  return chain;
}

const tx = {
  select: jest.fn(() => makeChain(() => Promise.resolve(shift(selectResults)))),
};

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  withTenantTx: (cb: (t: typeof tx) => Promise<unknown>) => { txCount += 1; return cb(tx); },
  drizzleCount: (r: unknown) => r,
}));

const { paginatedList } = await import('../src/services/paginated-list.js');

describe('paginatedList', () => {
  beforeEach(() => {
    selectResults = [];
    txCount = 0;
    tx.select.mockClear();
  });

  it('returns the row page and the total from the count row, in ONE transaction', async () => {
    selectResults = [[{ count: 7 }], [{ id: 'r1' }, { id: 'r2' }]];
    const result = await paginatedList({} as never, undefined, 'ordercol' as never, 25, 50);

    expect(result.total).toBe(7);
    expect(result.rows).toEqual([{ id: 'r1' }, { id: 'r2' }]);
    // count + list share a single withTenantTx (consistent snapshot).
    expect(txCount).toBe(1);
    // count query, then list query.
    expect(tx.select).toHaveBeenCalledTimes(2);
  });

  it('defaults total to 0 when the count row is absent', async () => {
    selectResults = [[], []];
    const result = await paginatedList({} as never, undefined, 'ordercol' as never, 25, 0);
    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
  });
});
