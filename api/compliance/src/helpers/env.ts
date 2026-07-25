// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse a positive-integer env var, falling back to `fallback` when the value
 * is missing, non-numeric, or not strictly positive. Single local copy shared
 * by the compliance tunables (validate limits, scan-executor batch sizes,
 * rule-operators regex cap) that each previously inlined this exact guard.
 */
export function parseIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
