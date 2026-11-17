// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's ONE semver module — dependency-free, so the CLI, the API
 * services and the data layer all order and match versions identically.
 *
 * Two families live here, deliberately distinct because their callers need
 * different contracts:
 *
 *  - **Precedence** (SemVer 2.0 §11, prereleases included). One comparator,
 *    {@link compareSemverParts}, with two string front-ends:
 *      - {@link compareSemver} — STRICT: throws on a non-version, returns
 *        exactly -1 / 0 / 1, accepts a leading `v` (CLI / client-version gate,
 *        where a bad value is a bug to surface).
 *      - {@link compareSemverLenient} — LENIENT: never throws, an unparseable
 *        value sorts LOWEST, returns any number (sorting stored rows, where one
 *        bad row must not fail the whole read). Uses the canonical grammar of
 *        {@link parseSemver} (no `v`, no leading zeros).
 *
 *  - **Matching**, again two grammars:
 *      - {@link satisfiesRange} — npm `engines`-style ranges (`>=`, `<`, `||`,
 *        partials, ...); null when the range is outside that syntax.
 *      - {@link satisfiesVersionSpec} — the plugin-reference spec grammar
 *        (exact / `^` / `~` / partial / `latest`, docs/plugin-installing.md),
 *        mirrored in SQL by pipeline-data's `versionSpecCondition`.
 */

// -- Parsing ------------------------------------------------------------------

/** A parsed `major.minor.patch[-prerelease][+build]` version. */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable version. */
  prerelease: string[];
}

/** Canonical SemVer 2.0 grammar (no leading zeros, no `v`). */
const CANONICAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** Loose grammar for {@link isSemver} / {@link compareSemver}: a leading `v` is allowed. */
const LOOSE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Upper bound on any numeric part (keeps pipeline-data's SQL `::int` casts in range). */
const MAX_PART = 2_147_483_647;

/** Parse a canonical semver string, or `null` when it isn't one. */
export function parseSemver(version: string): SemverParts | null {
  const m = CANONICAL.exec(version.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major > MAX_PART || minor > MAX_PART || patch > MAX_PART) return null;
  return { major, minor, patch, prerelease: m[4] ? m[4].split('.') : [] };
}

function parseLoose(v: string): SemverParts | null {
  const m = LOOSE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [] };
}

/** True for a full `x.y.z[-pre][+build]` version (a leading `v` is allowed). */
export function isSemver(v: string): boolean {
  return parseLoose(v) !== null;
}

// -- Precedence ---------------------------------------------------------------

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1; // numeric identifiers sort below alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer 2.0 §11 precedence: negative when `a < b`, 0 when equal, positive when
 * `a > b`. Numeric x.y.z, a prerelease sorts before its release, prerelease
 * identifiers compare numerically when both are numeric (`rc.2` < `rc.10`),
 * else as ASCII, with a numeric identifier below an alphanumeric one and a
 * shorter set below a longer one that it prefixes.
 */
export function compareSemverParts(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A stable version outranks any prerelease of the same tuple.
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const c = compareIdentifiers(a.prerelease[i]!, b.prerelease[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * STRICT -1 / 0 / 1 ordering of two versions ({@link compareSemverParts}).
 * A leading `v` is allowed. Throws on a value that isn't a version — use
 * {@link compareSemverLenient} to sort data that may hold one.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseLoose(a);
  const y = parseLoose(b);
  if (!x || !y) throw new Error(`Not a semver version: ${!x ? a : b}`);
  return Math.sign(compareSemverParts(x, y)) as -1 | 0 | 1;
}

/**
 * LENIENT ordering ({@link compareSemverParts} over {@link parseSemver}):
 * never throws, unparseable versions sort LOWEST (two of them compare equal).
 * Returns any number; only its sign is meaningful.
 */
export function compareSemverLenient(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  return compareSemverParts(pa, pb);
}

// -- npm engines-style ranges ---------------------------------------------------
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

// -- Plugin version specs (docs/plugin-installing.md) --------------------------
//
//   exact    `1.2.3`, `1.2.3-rc.1`   that one version
//   caret    `^1.2.3`                >=1.2.3 <2.0.0  (`^0.2.3` <0.3.0, `^0.0.3` <0.0.4)
//            `^1`, `^1.2`            >=1.0.0 <2.0.0, >=1.2.0 <2.0.0  (`^0.2` <0.3.0, `^0` <1.0.0)
//   tilde    `~1.2.3`                >=1.2.3 <1.3.0
//            `~1`, `~1.2`            >=1.0.0 <2.0.0, >=1.2.0 <1.3.0
//   partial  `1`, `1.x`, `1.2`, `1.2.x`  >=1.0.0 <2.0.0 / >=1.2.0 <1.3.0
//   latest   `latest`                the highest stable version
//
// npm semantics throughout, including prereleases: a range never matches a
// prerelease unless its own lower bound is a prerelease of the SAME
// major.minor.patch (so `^1.2.3-beta.1` admits `1.2.3-beta.2` but not
// `1.3.0-beta.1`). An exact spec may name a prerelease directly.

/** A parsed version spec. `range` bounds are `[min, max)`. */
export type VersionSpec =
  | { kind: 'exact'; version: string }
  | { kind: 'latest' }
  | { kind: 'range'; min: SemverParts; max: SemverParts };

const PARTIAL = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(x|\*))?$/;

const parts = (major: number, minor: number, patch: number, prerelease: string[] = []): SemverParts =>
  ({ major, minor, patch, prerelease });

/**
 * Parse a version spec, or `null` when it is none of the supported forms (the
 * caller then treats the input as a literal version, which matches nothing).
 */
export function parseVersionSpec(spec: string): VersionSpec | null {
  const s = spec.trim();
  if (s === 'latest') return { kind: 'latest' };

  if (s.startsWith('^') || s.startsWith('~')) {
    const partial = PARTIAL.exec(s.slice(1));
    if (partial && !parseSemver(s.slice(1))) return partialOperatorRange(s[0] as '^' | '~', partial);
    const base = parseSemver(s.slice(1));
    if (!base) return null;
    const { major, minor, patch } = base;
    let max: SemverParts;
    if (s[0] === '~') max = parts(major, minor + 1, 0);
    else if (major > 0) max = parts(major + 1, 0, 0);
    else if (minor > 0) max = parts(0, minor + 1, 0);
    else max = parts(0, 0, patch + 1);
    return { kind: 'range', min: base, max };
  }

  if (parseSemver(s)) return { kind: 'exact', version: s };

  const m = PARTIAL.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minorWild = m[2] === undefined || m[2] === 'x' || m[2] === '*';
  if (major > MAX_PART) return null;
  if (minorWild) return { kind: 'range', min: parts(major, 0, 0), max: parts(major + 1, 0, 0) };
  const minor = Number(m[2]);
  if (minor > MAX_PART) return null;
  return { kind: 'range', min: parts(major, minor, 0), max: parts(major, minor + 1, 0) };
}

/**
 * `^` / `~` over a PARTIAL version (npm): the missing parts are zero, and the
 * upper bound follows the operator — `^1` / `~1` <2.0.0, `^1.2` <2.0.0 but
 * `~1.2` <1.3.0, and a zero major narrows a caret to the next minor
 * (`^0.2` <0.3.0) or major (`^0` <1.0.0).
 */
function partialOperatorRange(op: '^' | '~', m: RegExpExecArray): VersionSpec | null {
  const major = Number(m[1]);
  const minorGiven = m[2] !== undefined && m[2] !== 'x' && m[2] !== '*';
  const minor = minorGiven ? Number(m[2]) : 0;
  if (major > MAX_PART || minor > MAX_PART) return null;
  const min = parts(major, minor, 0);
  if (!minorGiven) return { kind: 'range', min, max: parts(major + 1, 0, 0) };
  if (op === '~' || major === 0) return { kind: 'range', min, max: parts(major, minor + 1, 0) };
  return { kind: 'range', min, max: parts(major + 1, 0, 0) };
}

/** True when `spec` resolves to a SET of versions (range or `latest`), not one. */
export function isVersionRange(spec: string): boolean {
  const parsed = parseVersionSpec(spec);
  return parsed !== null && parsed.kind !== 'exact';
}

/** Whether `version` satisfies `spec` (a string or an already-parsed spec). */
export function satisfiesVersionSpec(version: string, spec: string | VersionSpec): boolean {
  const parsed = typeof spec === 'string' ? parseVersionSpec(spec) : spec;
  if (!parsed) return typeof spec === 'string' && version === spec;
  if (parsed.kind === 'exact') return version === parsed.version;
  const v = parseSemver(version);
  if (!v) return false;
  if (parsed.kind === 'latest') return v.prerelease.length === 0;
  if (compareSemverParts(v, parsed.min) < 0 || compareSemverParts(v, parsed.max) >= 0) return false;
  if (v.prerelease.length === 0) return true;
  const { min } = parsed;
  return min.prerelease.length > 0 && v.major === min.major && v.minor === min.minor && v.patch === min.patch;
}

/** The highest of `versions` satisfying `spec`, or `null`. */
export function maxSatisfying(versions: readonly string[], spec: string | VersionSpec): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (satisfiesVersionSpec(v, spec) && (best === null || compareSemverLenient(v, best) > 0)) best = v;
  }
  return best;
}
