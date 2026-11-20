// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether two id strings name the same document. ObjectId hex is
 * case-insensitive (Mongo casts `AAAA…` and `aaaa…` to the same id), so a
 * self-guard that compares a path id to the caller's `sub` exactly lets a
 * re-cased id slip past it. Every "is this the caller?" check compares here.
 */
export function isSameId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}
