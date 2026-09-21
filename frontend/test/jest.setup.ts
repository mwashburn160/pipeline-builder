// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Jest setup file (runs after the test framework is installed in the env).
 * Registers @testing-library/jest-dom matchers like toBeInTheDocument,
 * toHaveTextContent, etc. so all .test.tsx files can use them without
 * a per-file import.
 */

// The `jest-globals` entry: tests import `expect` from `@jest/globals` (there is
// no `@types/jest` global namespace in this repo), so the matchers must extend
// THAT expect — and its types — rather than the global one.
import '@testing-library/jest-dom/jest-globals';
import { configure } from '@testing-library/react';
import { clearQueryCache } from '../src/lib/query-cache';

// Testing Library's `findBy*`/`waitFor` default to a 1 s ceiling, which is a
// budget for a MACHINE, not for a component: the same `findByRole` that resolves
// in 250 ms on an idle box misses it when ~236 suites are competing for cores.
// That produced failures that looked like assertion bugs ("Unable to find
// role=option…") in a rotating cast of render-heavy suites — EditPluginModal,
// build-queue-paging, totp-qr-code — every one of which passed when run alone.
//
// Raising the ceiling costs passing tests nothing: these helpers resolve as soon
// as the element appears and only the failing path waits it out. It does not mask
// a real hang either, since jest's own per-test timeout still applies.
configure({ asyncUtilTimeout: 5_000 });

// The shared read cache is module state, so it outlives a test the way it
// outlives a navigation. Reset it between cases or one test's fetch satisfies
// the next one's, and `toHaveBeenCalledTimes` assertions drift with test order.
//
// Reached through `globalThis` because `next build` type-checks this file with
// the APP's tsconfig, which carries no test-runner types (the .test.ts files are
// skipped by that pass; this setup file is not).
(globalThis as unknown as { beforeEach: (fn: () => void) => void })
  .beforeEach(() => { clearQueryCache(); });

// jsdom implements neither half of the object-URL API, and every one-time
// secret the app reveals offers a Download (SecretActions) built from a blob.
// Without this a component that merely RENDERS one throws in an effect, which
// looks like a component bug rather than a missing browser API.
const url = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
if (typeof url.createObjectURL !== 'function') {
  let seq = 0;
  url.createObjectURL = () => `blob:jest/${++seq}`;
  url.revokeObjectURL = () => {};
}
