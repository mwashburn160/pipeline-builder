// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A whole-surface `@/lib/api` double for render-and-interact suites that mount
 * REAL component trees (the pipeline builder, its editors, the template modals).
 *
 * Those trees call dozens of API methods on the way to the one a test asserts on
 * (plugin lists for the pickers, the toolchain selector's reads, lookups for the
 * resolution warnings…). Listing every one by hand in each suite's mock factory
 * makes the suite break whenever a child component reads one more thing — which
 * is exactly the coupling a "real children" test should not have. So every
 * method the code touches exists: unknown names answer a bare success
 * envelope (`{ success: true }`, no `data`), `stream*` names answer an empty SSE
 * stream, and a test configures only the calls it cares about.
 *
 *   jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
 *   import { apiFn, resetApiMock } from './helpers/apiMock';
 *   apiFn('createPipeline').mockResolvedValue({ success: true, data: { inserted: true } });
 *   expect(apiFn('createPipeline')).toHaveBeenCalledWith(expect.objectContaining({ … }));
 *
 * Each method is a stable wrapper over a per-name `jest.fn`; a stub that
 * returns `undefined` (no implementation configured, or one wiped by
 * `restoreMocks`) falls through to the default envelope, so a test never has to
 * re-arm the background reads in every `beforeEach`.
 */

import { jest } from '@jest/globals';
import type { AnyFn } from './mock-fn';

const fns = new Map<string, jest.Mock<AnyFn>>();
const wrappers = new Map<string, AnyFn>();

/** Names that must NOT look like methods (module interop / thenable probes). */
const NOT_METHODS = new Set(['then', 'default', '__esModule', 'constructor', 'toJSON', 'asymmetricMatch', '$$typeof', 'nodeType']);

/** Drained list helpers that resolve a bare array, not an envelope. */
const ARRAY_METHODS = new Set(['getAllPluginCatalog', 'listAllPipelines']);

/** The envelope an unconfigured method resolves with. */
function defaultResult(name: string): unknown {
  if (ARRAY_METHODS.has(name)) return Promise.resolve([]);
  if (name.startsWith('stream')) {
    return (async function* empty() { /* no events */ })();
  }
  return Promise.resolve({ success: true });
}

/** The jest.fn behind `api[name]` — configure and assert on it. */
export function apiFn(name: string): jest.Mock<AnyFn> {
  let fn = fns.get(name);
  if (!fn) {
    fn = jest.fn<AnyFn>();
    fns.set(name, fn);
  }
  return fn;
}

function wrapper(name: string): AnyFn {
  let w = wrappers.get(name);
  if (!w) {
    w = (...args: unknown[]) => {
      const out = apiFn(name)(...args);
      return out === undefined ? defaultResult(name) : out;
    };
    wrappers.set(name, w);
  }
  return w;
}

/** Drop every configured stub (call history and implementations). */
export function resetApiMock(): void {
  for (const fn of fns.values()) fn.mockReset();
}

const target: Record<string, unknown> = {};

/** The proxied `api` object. */
export const apiProxy = new Proxy(target, {
  get(_t, key) {
    if (typeof key !== 'string' || NOT_METHODS.has(key)) return undefined;
    return wrapper(key);
  },
  has(_t, key) {
    return typeof key === 'string' && !NOT_METHODS.has(key);
  },
});

/** The `jest.mock('@/lib/api', …)` factory body. Keeps the real error classes. */
export function apiMockModule() {
  const errors = jest.requireActual<typeof import('../../src/lib/api/errors')>('../../src/lib/api/errors');
  return {
    __esModule: true,
    default: apiProxy,
    api: apiProxy,
    ApiError: errors.ApiError,
    ConflictError: errors.ConflictError,
  };
}
