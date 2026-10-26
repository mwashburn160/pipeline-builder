// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed environment-variable readers with consistent parsing + defaults.
 *
 * Hand-rolled `parseInt(process.env.X || '…', 10)` / `process.env.X === 'true'`
 * drifts (the same var parsed with different defaults in different packages)
 * and silently returns the default on a typo'd name. These helpers centralize the parsing so a value
 * is read the same way everywhere, and make shared constants importable rather
 * than re-derived (see `MAX_PAGE_LIMIT` / `DEFAULT_PAGE_LIMIT` in
 * `validation/common-schemas.ts`).
 */

/**
 * Parse an integer env var. Unset / blank / not a clean integer string → `def`.
 * Optional `min`/`max` clamp the result (applied after the default).
 *
 * STRICT on purpose: `parseInt` accepts `50.5` (→ 50) and `12abc` (→ 12), which
 * is how a typo'd quota limit or timeout silently ships a value nobody wrote.
 * Anything that isn't `-?\d+` falls back to the code default instead.
 */
export function envInt(name: string, def: number, opts?: { min?: number; max?: number }): number {
  const raw = process.env[name];
  const trimmed = raw?.trim() ?? '';
  let n = trimmed !== '' && /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : def;
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

/** Read a string env var; unset / blank → `def`. */
export function envStr(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? def : raw;
}

/**
 * Is a Postgres read replica configured AND switched on?
 *
 * Lives in api-core, not pipeline-data, even though the read POOL does. It is
 * pure env logic with no database dependency, and BOTH packages need it:
 * pipeline-data to decide whether to build the pool, and api-server's
 * tenant-context middleware to decide whether the cross-request write pin is in
 * play at all.
 *
 * WHY THAT PLACEMENT IS LOAD-BEARING, not taste. api-server's middleware runs in
 * EVERY service, and 91 test suites stub `@pipeline-builder/pipeline-data` with
 * `stubModule`, which THROWS on access to an export the suite did not override —
 * deliberately, to force explicitness. So reaching into pipeline-data from the
 * middleware turned every one of those suites into a 500, and patching 91 stubs
 * would only defer the next one. api-core's mocks spread `requireActual`, so a
 * symbol here is available to all of them without a single stub edit.
 *
 * `DB_READ_ENABLED=false` is the KILL SWITCH: it forces every read back to the
 * primary without a redeploy or a manifest change, which the unset-host fallback
 * does not cover. Unset host answers "there is no replica"; the kill switch
 * answers "there is one and I do not trust it".
 *
 * `.trim()` matters: `DB_READ_HOST=" "` from a stray space must not read as
 * "a replica exists".
 */
export function isReadReplicaConfigured(): boolean {
  if (!envBool('DB_READ_ENABLED', true)) return false;
  return envStr('DB_READ_HOST', '').trim().length > 0;
}
