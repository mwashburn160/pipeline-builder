// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed environment-variable readers with consistent parsing + defaults.
 *
 * Services previously hand-rolled `parseInt(process.env.X || '…', 10)` /
 * `process.env.X === 'true'` at hundreds of call sites — which drifts (the same
 * var parsed with different defaults in different packages) and silently returns
 * the default on a typo'd name. These helpers centralize the parsing so a value
 * is read the same way everywhere, and make shared constants importable rather
 * than re-derived (see `MAX_PAGE_LIMIT` / `DEFAULT_PAGE_LIMIT` in
 * `validation/common-schemas.ts`).
 */

/**
 * Parse an integer env var. Unset / blank / non-numeric → `def`. Optional
 * `min`/`max` clamp the result (applied after the default).
 */
export function envInt(name: string, def: number, opts?: { min?: number; max?: number }): number {
  const raw = process.env[name];
  let n = raw === undefined || raw.trim() === '' ? def : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) n = def;
  if (opts?.min !== undefined) n = Math.max(opts.min, n);
  if (opts?.max !== undefined) n = Math.min(opts.max, n);
  return n;
}

/**
 * Parse a boolean env var. `true`/`1`/`yes` → true, `false`/`0`/`no` → false
 * (case-insensitive); unset / blank / unrecognized → `def`.
 */
export function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

/** Read an env var constrained to `allowed`; unset / not-in-set → `def`. */
export function envEnum<T extends string>(name: string, allowed: readonly T[], def: T): T {
  const raw = process.env[name]?.trim() as T | undefined;
  return raw !== undefined && allowed.includes(raw) ? raw : def;
}

/** Read a string env var; unset / blank → `def`. */
export function envStr(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? def : raw;
}
