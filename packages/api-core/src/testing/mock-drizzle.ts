// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `drizzle-orm` module mock for ESM suites.
 *
 * WHY: eighteen suites hand-wrote `jest.unstable_mockModule('drizzle-orm', () => ({ … }))`
 * with whatever operator subset they happened to need. `unstable_mockModule`
 * replaces the WHOLE namespace, so the moment production code reached for an
 * operator a suite had not listed (`desc` was present in 6 of the 18, absent in
 * 12) ESM linking failed with "does not provide an export named X" — a build
 * break with no relationship to the change that triggered it.
 *
 * THE FIX: start from the REAL module and overlay only what a suite asserts on.
 * A new drizzle export — or a new operator used by production code — is inherited
 * automatically, so the drift class is gone rather than merely re-synchronised.
 *
 * WHY IT LIVES IN api-core: every service already imports test fixtures from
 * the `@pipeline-builder/api-core/testing` entry (see tier-mock.ts). That entry is
 * NOT intercepted by a suite's `@pipeline-builder/api-core` module mock, so the
 * factory is safe to import from inside a suite that mocks the api-core barrel.
 *
 * USAGE:
 *   import { drizzleMock } from '@pipeline-builder/api-core/testing';
 *   jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
 *     eq: (col: unknown, val: unknown) => ({ _kind: 'eq', col, val }),
 *   }));
 *
 * The eslint `no-restricted-syntax` rule added in `.projenrc.ts` fails any suite
 * that goes back to an inline object literal here.
 */

import { jest } from '@jest/globals';

/**
 * The REAL drizzle-orm namespace, resolved LAZILY (and memoised) — evaluating it
 * at module load races the ESM loader when a suite's static import graph already
 * has drizzle in flight. `requireActual` bypasses the module mock, so this is
 * safe to call from inside the very factory that replaces it.
 */
let actualDrizzleCache: Record<string, unknown> | undefined;
try {
  actualDrizzleCache = jest.requireActual('drizzle-orm') as Record<string, unknown>;
} catch {
  actualDrizzleCache = undefined;
}
function actualDrizzle(): Record<string, unknown> {
  actualDrizzleCache ??= jest.requireActual('drizzle-orm') as Record<string, unknown>;
  return actualDrizzleCache;
}

/**
 * Build a `drizzle-orm` mock namespace: every real export, with `overrides`
 * spread last so a suite can swap an operator for an inspectable stub (or a
 * `jest.fn()` it asserts on) without having to enumerate the rest.
 */
export function drizzleMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...actualDrizzle(), ...overrides };
}
