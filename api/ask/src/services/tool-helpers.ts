// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared plumbing for the agent's read + propose tools.
 *
 * Three jobs:
 *  - unwrap the services' `{ data: … }` envelope,
 *  - SHAPE a downstream read into the few facts the model needs (design rule 5:
 *    anything in the model's context can surface in its prose, so addresses,
 *    webhook URLs and raw error bodies must never get there),
 *  - turn a model-supplied `changes` object plus the entity's CURRENT state into
 *    the `{ changedFields, current, proposed, changedPaths, refusedFields }`
 *    diff every change proposal carries (design rules 1, 3 and 10).
 */

/** Unwrap `sendSuccess`'s `{ data: … }` envelope; tolerate a bare body. */
export function unwrap<T>(res: unknown): T | undefined {
  if (res && typeof res === 'object' && 'data' in res) {
    return (res as { data?: T }).data;
  }
  return res as T | undefined;
}

/** A plain object, or `{}` — never an array. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** An array, or `[]`. */
export function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Run a downstream read that the caller may legitimately lack permission for
 * (a member without `plugins:write` cannot see the build queue) and report the
 * outcome instead of failing the whole tool. The reason is the client's own
 * status-only message — never a downstream body.
 */
export async function settle<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unavailable' };
  }
}

/** Structural equality for JSON-ish values (order-sensitive for arrays). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/** Stable key order so two structurally equal objects serialize identically. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(src).sort().map((k) => [k, sortKeys(src[k])]));
  }
  return v;
}

/** Cap on how many leaf paths a diff reports — a card renders a list, not a dump. */
const MAX_CHANGED_PATHS = 200;

/**
 * Dotted leaf paths that differ between two values. Used only for DISPLAY — the
 * commit payload is keyed by the top-level `changedFields`, never by these.
 */
export function changedPaths(current: unknown, proposed: unknown, prefix = ''): string[] {
  const out: string[] = [];
  walk(current, proposed, prefix, out);
  return out.slice(0, MAX_CHANGED_PATHS);
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= MAX_CHANGED_PATHS) return;
  if (sameValue(a, b)) return;
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    out.push(path || '(root)');
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    walk(left[key], right[key], path ? `${path}.${key}` : key, out);
  }
}

/** The diff half of a change proposal. */
export interface FieldDiff {
  changedFields: string[];
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  changedPaths: string[];
  refusedFields: string[];
}

/**
 * Build the diff a change proposal carries.
 *
 * `allowed` is the tool's ALLOWLIST (design rule 1): a key outside it is refused
 * and counted, never applied — a new settable field stays unavailable to the
 * agent until somebody deliberately adds it. A key whose proposed value already
 * equals the current one is dropped: the card must show only real changes, so
 * "no-op padding" cannot pad a diff a reviewer then skims past.
 */
export function buildDiff(
  currentDoc: Record<string, unknown>,
  changes: Record<string, unknown>,
  allowed: readonly string[],
): FieldDiff {
  const allow = new Set(allowed);
  const changedFields: string[] = [];
  const current: Record<string, unknown> = {};
  const proposed: Record<string, unknown> = {};
  const paths: string[] = [];
  const refusedFields: string[] = [];

  for (const key of Object.keys(changes)) {
    if (!allow.has(key)) {
      refusedFields.push(key);
      continue;
    }
    const before = currentDoc[key];
    const after = changes[key];
    if (sameValue(before, after)) continue;
    changedFields.push(key);
    current[key] = before ?? null;
    proposed[key] = after;
    paths.push(...changedPaths(before, after, key));
  }

  return { changedFields, current, proposed, changedPaths: paths.slice(0, MAX_CHANGED_PATHS), refusedFields };
}
