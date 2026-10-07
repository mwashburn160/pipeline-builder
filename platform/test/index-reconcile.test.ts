// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time index reconciliation.
 *
 * The behaviour being protected is narrow and the stakes are asymmetric:
 *
 *   - a CONFLICTING index (same name, changed definition) must be rebuilt,
 *     because Mongoose will not touch it and writes keep failing against the
 *     old definition — the `role_assignments` E11000 that motivated this;
 *   - an UNRECOGNISED index must be left alone. The most likely thing in that
 *     set is an index an operator added by hand to rescue a slow query, and
 *     dropping it silently during a restart is worse than the drift.
 *
 * The second is the one worth a test: a `syncIndexes()` would pass every
 * "rebuilds a drifted index" assertion and quietly delete the operator's work.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { reconcileModel } from '../src/utils/index-reconcile.js';

jest.mock('../src/observability/metrics.js', () => ({
  incCounter: jest.fn(),
  setGauge: jest.fn(),
}));

/** A stand-in Model: the two calls the reconciler makes, plus a schema. */
function fakeModel(opts: {
  live: Record<string, unknown>[];
  declared: [Record<string, number>, Record<string, unknown>?][];
  onDrop?: (name: string) => void;
}) {
  const dropped: string[] = [];
  const created: number[] = [];
  const model = {
    collection: {
      name: 'role_assignments',
      dropIndex: async (name: string) => { dropped.push(name); opts.onDrop?.(name); },
    },
    schema: { indexes: () => opts.declared },
    listIndexes: async () => opts.live,
    createIndexes: async () => { created.push(1); },
  };
  return { model: model as never, dropped, created };
}

const ID_INDEX = { name: '_id_', key: { _id: 1 } };

describe('reconcileModel', () => {
  it('rebuilds an index whose definition changed — the role_assignments case', async () => {
    // Live: the pre-2026-09-18 plain unique index. Declared: the partial one.
    const { model, dropped, created } = fakeModel({
      live: [ID_INDEX, { name: 'userId_1_roleId_1', key: { userId: 1, roleId: 1 }, unique: true }],
      declared: [[{ userId: 1, roleId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }]],
    });
    const r = await reconcileModel(model);
    expect(dropped).toEqual(['userId_1_roleId_1']);
    expect(created).toHaveLength(1);
    expect(r.rebuilt).toEqual(['role_assignments.userId_1_roleId_1']);
  });

  it('leaves an index that matches alone', async () => {
    const { model, dropped } = fakeModel({
      live: [ID_INDEX, { name: 'userId_1_roleId_1', key: { userId: 1, roleId: 1 }, unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }],
      declared: [[{ userId: 1, roleId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }]],
    });
    const r = await reconcileModel(model);
    expect(dropped).toEqual([]);
    expect(r.rebuilt).toEqual([]);
  });

  it('REPORTS an index no schema declares, and does not drop it', async () => {
    // The operator's hand-added index. A syncIndexes() would delete this.
    const { model, dropped } = fakeModel({
      live: [ID_INDEX, { name: 'createdAt_-1', key: { createdAt: -1 } }],
      declared: [[{ userId: 1, roleId: 1 }, { unique: true }]],
    });
    const r = await reconcileModel(model);
    expect(dropped).toEqual([]);
    expect(r.unknown).toEqual(['role_assignments.createdAt_-1']);
  });

  it('ignores cosmetic server fields rather than rebuilding on every upgrade', async () => {
    // `v`, `ns` and `background` are added by the server and differ across
    // versions; comparing them would rebuild every index on an upgrade.
    const { model, dropped } = fakeModel({
      live: [ID_INDEX, { name: 'organizationId_1_userId_1', key: { organizationId: 1, userId: 1 }, v: 2, ns: 'platform.role_assignments', background: true } as never],
      declared: [[{ organizationId: 1, userId: 1 }]],
    });
    expect((await reconcileModel(model)).rebuilt).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('treats a changed key ORDER as drift, because a compound index is order-sensitive', async () => {
    const { model, dropped } = fakeModel({
      live: [ID_INDEX, { name: 'a_1_b_1', key: { b: 1, a: 1 } }],
      declared: [[{ a: 1, b: 1 }, { name: 'a_1_b_1' }]],
    });
    await reconcileModel(model);
    expect(dropped).toEqual(['a_1_b_1']);
  });

  it('records a failed drop instead of throwing, so boot is never blocked', async () => {
    const { model } = fakeModel({
      live: [ID_INDEX, { name: 'userId_1_roleId_1', key: { userId: 1, roleId: 1 }, unique: true }],
      declared: [[{ userId: 1, roleId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }]],
      onDrop: () => { throw new Error('not authorized on platform to execute dropIndexes'); },
    });
    const r = await reconcileModel(model);
    expect(r.rebuilt).toEqual([]);
    expect(r.failed).toEqual(['role_assignments.userId_1_roleId_1']);
  });

  it('is quiet about a collection that does not exist yet', async () => {
    const model = {
      collection: { name: 'role_assignments', dropIndex: async () => undefined },
      schema: { indexes: () => [] },
      listIndexes: async () => { throw new Error('ns does not exist: platform.role_assignments'); },
      createIndexes: async () => undefined,
    };
    const r = await reconcileModel(model as never);
    expect(r).toEqual({ rebuilt: [], unknown: [], failed: [] });
  });
});
