// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Jest setup file (runs after the test framework is installed in the env).
 * Registers @testing-library/jest-dom matchers like toBeInTheDocument,
 * toHaveTextContent, etc. so all .test.tsx files can use them without
 * a per-file import.
 */

import '@testing-library/jest-dom';
import { clearQueryCache } from '../src/lib/query-cache';

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
