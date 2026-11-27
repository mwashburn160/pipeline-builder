// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A seeded PRNG for the money-invariant property tests (mulberry32).
 *
 * Seeded rather than `Math.random` so a failing case reproduces exactly: the
 * failure message carries the seed and the iteration, and re-running gives the
 * same inputs. No dependency on a property-testing library.
 */
// A PRNG is bit arithmetic by definition.
/* eslint-disable no-bitwise */
export function prng(seed: number): { int: (min: number, max: number) => number; pick: <T>(xs: readonly T[]) => T } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return { int, pick: (xs) => xs[int(0, xs.length - 1)] };
}
