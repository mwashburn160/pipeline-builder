// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Version specs for plugin lookups (docs/plugin-installing.md).
 *
 * A small, dependency-free matcher for exactly the forms plugin references use:
 *
 *   exact    `1.2.3`, `1.2.3-rc.1`   that one version
 *   caret    `^1.2.3`                >=1.2.3 <2.0.0  (`^0.2.3` <0.3.0, `^0.0.3` <0.0.4)
 *            `^1`, `^1.2`            >=1.0.0 <2.0.0, >=1.2.0 <2.0.0  (`^0.2` <0.3.0, `^0` <1.0.0)
 *   tilde    `~1.2.3`                >=1.2.3 <1.3.0
 *            `~1`, `~1.2`            >=1.0.0 <2.0.0, >=1.2.0 <1.3.0
 *   partial  `1`, `1.x`, `1.2`, `1.2.x`  >=1.0.0 <2.0.0 / >=1.2.0 <1.3.0
 *   latest   `latest`                the highest stable version
 *
 * npm semantics throughout, including prereleases: a range never matches a
 * prerelease unless its own lower bound is a prerelease of the SAME
 * major.minor.patch (so `^1.2.3-beta.1` admits `1.2.3-beta.2` but not
 * `1.3.0-beta.1`). An exact spec may name a prerelease directly.
 *
 * The matcher runs in JS ({@link satisfiesVersionSpec}) and — for the query
 * builders — as SQL over the `version` column ({@link versionSpecCondition},
 * {@link semverOrderBy}); the two are kept equivalent by the shared tests.
 */

import { and, asc, desc, eq, or, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';

/** A parsed `major.minor.patch[-prerelease][+build]` version. */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable version. */
  prerelease: string[];
}

/** A parsed version spec. `range` bounds are `[min, max)`. */
export type VersionSpec =
  | { kind: 'exact'; version: string }
  | { kind: 'latest' }
  | { kind: 'range'; min: SemverParts; max: SemverParts };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PARTIAL = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(x|\*))?$/;

/** Upper bound on any numeric part (keeps SQL `::int` casts in range). */
const MAX_PART = 2_147_483_647;

/** Parse a full semver string, or `null` when it isn't one. */
export function parseSemver(version: string): SemverParts | null {
  const m = SEMVER.exec(version.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major > MAX_PART || minor > MAX_PART || patch > MAX_PART) return null;
  return { major, minor, patch, prerelease: m[4] ? m[4].split('.') : [] };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1; // numeric identifiers sort below alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver 2.0 precedence: negative when `a < b`, 0 when equal, positive when `a > b`. */
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

/** {@link compareSemverParts} over strings; unparseable versions sort lowest. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  return compareSemverParts(pa, pb);
}

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
    if (satisfiesVersionSpec(v, spec) && (best === null || compareSemver(v, best) > 0)) best = v;
  }
  return best;
}

// -- SQL ------------------------------------------------------------------------
//
// The `version` column is CHECK-constrained to `^\d+\.\d+\.\d+(-pre)?(\+build)?$`,
// so the numeric parts are split out reliably: major/minor are the first two
// dot fields, patch is the third with any `-pre` / `+build` suffix removed, and
// the prerelease is whatever sits between the first `-` and any `+`.

const majorOf = (col: AnyColumn): SQL => sql`split_part(${col}, '.', 1)::int`;
const minorOf = (col: AnyColumn): SQL => sql`split_part(${col}, '.', 2)::int`;
const patchOf = (col: AnyColumn): SQL => sql`substring(${col} from '^[0-9]+\\.[0-9]+\\.([0-9]+)')::int`;
/** The prerelease suffix, or NULL for a stable version. */
const prereleaseOf = (col: AnyColumn): SQL => sql`substring(split_part(${col}, '+', 1) from '^[0-9]+\\.[0-9]+\\.[0-9]+-(.+)$')`;

const tupleOf = (col: AnyColumn): SQL => sql`(${majorOf(col)}, ${minorOf(col)}, ${patchOf(col)})`;
const tupleLit = (p: SemverParts): SQL => sql`(${p.major}::int, ${p.minor}::int, ${p.patch}::int)`;

/**
 * SQL predicate for `col` satisfying `spec`. Precision note: prerelease-vs-
 * prerelease ordering WITHIN the lower bound's own tuple is not compared in SQL
 * (every prerelease of that tuple is admitted) — {@link semverOrderBy} still
 * ranks them, and the JS matcher is exact.
 */
export function versionSpecCondition(col: AnyColumn, spec: string): SQL {
  const parsed = parseVersionSpec(spec);
  if (!parsed) return eq(col, spec);
  if (parsed.kind === 'exact') return eq(col, parsed.version);
  const stable = sql`${prereleaseOf(col)} IS NULL`;
  if (parsed.kind === 'latest') return stable;

  const { min, max } = parsed;
  const inRange = and(sql`${tupleOf(col)} >= ${tupleLit(min)}`, sql`${tupleOf(col)} < ${tupleLit(max)}`)!;
  if (min.prerelease.length === 0) return and(inRange, stable)!;
  // A prerelease lower bound: stable versions above it, plus prereleases of its own tuple.
  return and(inRange, or(stable, sql`${tupleOf(col)} = ${tupleLit(min)}`))!;
}

/**
 * ORDER BY terms ranking `col` highest-semver first: numeric major/minor/patch,
 * a stable version above its prereleases, then the prerelease text (a
 * lexicographic tiebreak — close to, not exactly, semver identifier order).
 */
export function semverOrderBy(col: AnyColumn): SQL[] {
  return [
    desc(majorOf(col)),
    desc(minorOf(col)),
    desc(patchOf(col)),
    sql`${prereleaseOf(col)} IS NULL DESC`,
    desc(prereleaseOf(col)),
    asc(col),
  ];
}
