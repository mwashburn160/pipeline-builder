// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Filter an object to only include entries where the value is not `undefined`.
 * Keeps `null`, `false`, `0`, and empty string — only removes `undefined`.
 *
 * Useful for building partial update payloads from validated request bodies.
 *
 * @example
 * ```typescript
 * const body = { name: 'foo', description: undefined, isActive: false };
 * pickDefined(body); // { name: 'foo', isActive: false }
 * ```
 */
export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Deterministic JSON serialization with recursively sorted object keys, so the
 * same logical value always serializes (and hashes) identically:
 * - `undefined` / `null` → `null` (so absent fields hash identically).
 * - `Date` → its ISO string (Mongo round-trips these as `Date`).
 * - object keys are sorted; `undefined`-valued keys are dropped (JSON semantics).
 *
 * The audit hash chain depends on this output byte-for-byte: changing it
 * invalidates every stored chain.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
