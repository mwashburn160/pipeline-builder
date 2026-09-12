// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string equality, for comparing a presented secret against an
 * expected one (scrape tokens, shared webhook secrets, signatures).
 *
 * `a === b` on secrets short-circuits at the first differing byte, which leaks
 * the expected value a byte at a time to an attacker who can measure response
 * latency. `timingSafeEqual` does not — but it THROWS when the two buffers
 * differ in length, so length is compared first and the result is folded in
 * without an early return.
 *
 * The length check itself is not constant-time, so this leaks the expected
 * secret's LENGTH. That is acceptable for fixed-length tokens and is the
 * standard trade-off; do not use this where the length is itself the secret.
 */
export function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still run a comparison of equal-length buffers so a wrong-length guess
    // doesn't return measurably faster than a right-length one.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
