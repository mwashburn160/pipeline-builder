// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse a positive integer from an env var, falling back to `def` when the
 * value is unset, empty, non-numeric, or non-positive. Guards against a
 * typo'd/garbage env yielding `NaN` — which would otherwise silently break
 * dependent logic. For example, a `NaN` per-org build cap stringifies to
 * `'NaN'`, the slot-manager Lua's `tonumber(ARGV[1])` returns nil, and every
 * `tryAcquireOrgSlot` throws — bricking ALL plugin builds. A `NaN` cache TTL
 * makes `expiresAt = NaN` and `NaN > Date.now()` is always false so a cache
 * never hits; a `NaN` scrape/scan interval is likewise nonsensical.
 *
 * Kept in its own leaf module (no cross-package or intra-package deps) so every
 * queue module can import it directly without introducing an import cycle.
 */
export function intFromEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
