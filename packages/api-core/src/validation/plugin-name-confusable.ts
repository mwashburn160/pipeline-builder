// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Confusable plugin names (docs/plans/plugin-ecosystem.md §4.2 "Names", E9):
 * a new community listing — an anonymous submission or a `new_listing`
 * request — may not look like one of the directory's most-installed plugins
 * (`terraf0rm`, `kube-ctl`, `docker_build`, `tfsec` → `tfsed`).
 *
 * Two names are CONFUSABLE when, after {@link normalizeConfusableName}
 * (lowercase; strip `-`, `_`, `.`; `rn`→`m`, `vv`→`w`, `0`→`o`, `1`→`l`,
 * `3`→`e`, `5`→`s`), they are equal or one Damerau–Levenshtein edit apart
 * (an insertion, deletion, substitution or adjacent transposition).
 *
 * Pure, so the CLI can warn before a publish and the plugin service decides
 * with the same rule.
 */

const MULTI_CHAR: ReadonlyArray<[RegExp, string]> = [[/rn/g, 'm'], [/vv/g, 'w']];
const SINGLE_CHAR: Readonly<Record<string, string>> = { 0: 'o', 1: 'l', 3: 'e', 5: 's' };

/** The comparison form of a plugin name. */
export function normalizeConfusableName(name: string): string {
  let out = name.toLowerCase().replace(/[-_.]/g, '');
  for (const [from, to] of MULTI_CHAR) out = out.replace(from, to);
  return out.replace(/[0135]/g, (c) => SINGLE_CHAR[c] ?? c);
}

/**
 * Optimal-string-alignment Damerau–Levenshtein distance between `a` and `b`,
 * giving up (returning `limit + 1`) once it must exceed `limit`.
 */
export function damerauLevenshtein(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prevPrev[j - 2]! + 1);
      cur.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > limit) return limit + 1;
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The first of `names` that `candidate` is confusable with (see the module
 * note), or null. An EXACT match counts too — the caller decides whether the
 * same name is a conflict or the same listing.
 */
export function findConfusableName(candidate: string, names: Iterable<string>): string | null {
  const c = normalizeConfusableName(candidate);
  if (c.length === 0) return null;
  for (const name of names) {
    const n = normalizeConfusableName(name);
    if (n.length === 0) continue;
    if (c === n || damerauLevenshtein(c, n, 1) <= 1) return name;
  }
  return null;
}

/** Whether `candidate` is confusable with any of `names`. */
export function isConfusableName(candidate: string, names: Iterable<string>): boolean {
  return findConfusableName(candidate, names) !== null;
}
