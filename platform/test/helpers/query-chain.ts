// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mongoose query doubles for model mocks. `queryChain(value)` answers every
 * chain step a platform query uses (`select`, `session`, `sort`, `limit`,
 * `skip`, `populate`) and resolves to `value` from `lean()` — or when awaited
 * directly. The narrow shapes are for suites that assert a specific chain.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function queryChain<T>(value: T): any {
  const c: any = {
    lean: async () => value,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject),
  };
  for (const step of ['select', 'session', 'sort', 'limit', 'skip', 'populate']) c[step] = () => c;
  return c;
}

/** `.select(...).lean()` → `value`. */
export const selectLean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

/** `.lean()` → `value`. */
export const leanOf = (value: unknown) => ({ lean: () => Promise.resolve(value) });
