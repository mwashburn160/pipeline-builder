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

/**
 * A comparator's version operand: 0-3 numeric parts (`26`, `26.5`, `26.5.1`),
 * where a trailing `x` / `X` / `*` part counts as absent (`26.x` = `26`). A
 * prerelease is only meaningful on a full version. Null when unparseable.
 */
interface Operand { nums: number[]; pre: string }

function parsePartial(v: string): Operand | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((p): p is string => p !== undefined);
  const wild = parts.findIndex((p) => !/^\d+$/.test(p));
  // A number after a wildcard (`1.x.3`) has no meaning.
  if (wild >= 0 && parts.slice(wild).some((p) => /^\d+$/.test(p))) return null;
  const nums = (wild >= 0 ? parts.slice(0, wild) : parts).map(Number);
  if (m[4] && nums.length < 3) return null;
  return { nums, pre: m[4] ?? '' };
}

type Bound = ['>=' | '>' | '<=' | '<' | '=', string];

/** `nums` padded to x.y.z with zeros. */
function full(nums: number[], pre = ''): string {
  return `${nums[0] ?? 0}.${nums[1] ?? 0}.${nums[2] ?? 0}${pre}`;
}

/**
 * The exclusive upper bound one past the last part that is fixed: `bumpAt([1,2,3], 0)`
 * is `2.0.0-0`, `bumpAt([1,2,3], 1)` is `1.3.0-0`. The `-0` keeps the next
 * version's prereleases out, as npm does.
 */
function bumpAt(nums: number[], i: number): string {
  const out = [0, 0, 0];
  for (let k = 0; k < i; k++) out[k] = nums[k] ?? 0;
  out[i] = (nums[i] ?? 0) + 1;
  return `${full(out)}-0`;
}

/**
 * One comparator desugared to plain bounds, with npm's meaning for partial
 * operands: a bare or `=` partial is the whole span it names (`26` =
 * `>=26.0.0 <27.0.0-0`), `<=26` = `<27.0.0-0`, `>26` = `>=27.0.0`, `~` fixes
 * major.minor (major alone when only that is given), and `^` fixes the
 * left-most non-zero part among those given (`^0.0.3` = exactly `0.0.3`).
 * An empty list matches anything; null means the comparator matches nothing.
 */
function bounds(op: string, p: Operand): Bound[] | null {
  const n = p.nums.length;
  const lower = full(p.nums, p.pre);
  if (n === 0) return op === '<' || op === '>' ? null : [];
  switch (op) {
    case '>=': return [['>=', lower]];
    case '>': return n === 3 ? [['>', lower]] : [['>=', bumpAt(p.nums, n - 1).replace(/-0$/, '')]];
    case '<': return [['<', n === 3 ? lower : `${lower}-0`]];
    case '<=': return n === 3 ? [['<=', lower]] : [['<', bumpAt(p.nums, n - 1)]];
    case '~': return [['>=', lower], ['<', bumpAt(p.nums, n === 1 ? 0 : 1)]];
    case '^': {
      // The left-most non-zero part, or the last one given when all are zero.
      const nz = p.nums.findIndex((x) => x !== 0);
      return [['>=', lower], ['<', bumpAt(p.nums, nz >= 0 ? nz : n - 1)]];
    }
    default: return n === 3 ? [['=', lower]] : [['>=', lower], ['<', bumpAt(p.nums, n - 1)]];
  }
}

function satisfiesComparator(version: string, comparator: string): boolean | null {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
  if (!m) return null;
  const operand = parsePartial(m[2]!);
  if (!operand) return null;
  const set = bounds(m[1] ?? '=', operand);
  if (set === null) return false;
  return set.every(([op, base]) => {
    const c = compareSemver(version, base);
    switch (op) {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  });
}

/**
 * Whether `version` satisfies an `engines`-style range with npm's semantics:
 * comparator sets joined by `||`, each a space-separated AND of `>=`, `>`,
 * `<=`, `<`, `=`, `^`, `~` or bare versions, any of which may be partial
 * (`26`, `26.5`, `26.x`, `>= 26`). `*` / empty match anything. Returns null
 * when the range uses syntax outside that (hyphen ranges), so the caller can
 * decide rather than guess.
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
