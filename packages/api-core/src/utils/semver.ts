// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The small slice of semver the platform needs without a dependency: ordering
 * versions (SemVer 2.0 §11, prereleases included) and checking a version
 * against an `engines`-style range. Shared by the CLI's `--upgrade` and the
 * server's minimum-client-version gate so both order versions identically.
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed { nums: [number, number, number]; pre: string[] }

function parse(v: string): Parsed | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** True for a full `x.y.z[-pre][+build]` version (a leading `v` is allowed). */
export function isSemver(v: string): boolean {
  return parse(v) !== null;
}

/**
 * -1 / 0 / 1 ordering of two versions per SemVer §11: numeric x.y.z, a
 * prerelease sorts before its release, and prerelease identifiers compare
 * numerically when both are numeric (`rc.2` < `rc.10`), else as ASCII, with a
 * numeric identifier below an alphanumeric one and a shorter set below a
 * longer one that it prefixes. Throws on a value that isn't a version.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new Error(`Not a semver version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i]! < y.nums[i]! ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** A partial version (`26`, `26.13`) padded to x.y.z, or null. */
function padded(v: string): string | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}${m[4] ?? ''}`;
}

function satisfiesComparator(version: string, comparator: string): boolean | null {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
  if (!m) return null;
  const op = m[1] ?? '=';
  const base = padded(m[2]!);
  if (!base) return null;
  const c = compareSemver(version, base);
  switch (op) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    case '=': return c === 0;
    default: {
      // ^ keeps the left-most non-zero part fixed; ~ keeps major.minor fixed.
      const [maj, min] = base.split(/[.-]/).map(Number) as [number, number];
      const upper = op === '~' ? `${maj}.${min + 1}.0` : maj > 0 ? `${maj + 1}.0.0` : `0.${min + 1}.0`;
      return c >= 0 && compareSemver(version, `${upper}-0`) < 0;
    }
  }
}

/**
 * Whether `version` satisfies an `engines`-style range: comparator sets joined
 * by `||`, each a space-separated AND of `>=`, `>`, `<=`, `<`, `=`, `^`, `~` or
 * bare versions (partials like `>= 26` allowed). `*` / empty match anything.
 * Returns null when the range uses syntax outside that (hyphen ranges, `x`
 * wildcards), so the caller can decide rather than guess.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  if (!isSemver(version)) return null;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;
  let any = false;
  for (const set of trimmed.split('||')) {
    // Join an operator to its version (`>= 26.13.0` → `>=26.13.0`), then split.
    const comparators = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    let all = true;
    for (const comparator of comparators) {
      const ok = satisfiesComparator(version, comparator);
      if (ok === null) return null;
      if (!ok) all = false;
    }
    if (all) any = true;
  }
  return any;
}
