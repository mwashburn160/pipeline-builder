// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mongoose query doubles for model mocks. `queryChain(value)` answers every
 * chain step a platform query uses (`select`, `session`, `sort`, `limit`,
 * `skip`, `populate`) and resolves to `value` from `lean()` — or when awaited
 * directly. The narrow shapes are for suites that assert a specific chain.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What `lean()` returns: awaitable AND streamable.
 *
 * A lean query is a thenable, so `await q.lean()` keeps working; it also answers
 * `.cursor()` with an async iterable over the same value, because code that
 * walks an unbounded collection streams it (`for await (… .lean().cursor())`)
 * rather than reading it into an array. A `lean()` that returned a bare Promise
 * made every such caller untestable for the wrong reason — the suite failed on
 * `.cursor is not a function`, which names the double rather than the behaviour.
 */
function leanResult<T>(value: T): any {
  const docs = Array.isArray(value) ? value : [];
  return {
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject),
    cursor: () => ({
      async *[Symbol.asyncIterator]() {
        for (const doc of docs) yield doc;
      },
    }),
  };
}

export function queryChain<T>(value: T): any {
  const c: any = {
    lean: () => leanResult(value),
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject),
  };
  for (const step of ['select', 'session', 'sort', 'limit', 'skip', 'populate']) c[step] = () => c;
  return c;
}

/** `.select(...).lean()` → `value`, awaited or streamed. */
export const selectLean = (value: unknown) => ({ select: () => ({ lean: () => leanResult(value) }) });

/** `.select(...).lean()` → whatever the PROJECTION asks for, awaited or streamed.
 *  For a model whose several reads are told apart by what they select. */
export const selectAwareLean = (byProjection: (projection: string) => unknown) => ({
  select: (projection: string) => ({ lean: () => leanResult(byProjection(String(projection))) }),
});

/** `.lean()` → `value`, awaited or streamed. */
export const leanOf = (value: unknown) => ({ lean: () => leanResult(value) });
