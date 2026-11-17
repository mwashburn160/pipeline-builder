// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Version specs for plugin lookups (docs/plugin-installing.md) — the SQL half.
 *
 * The JS matcher, the parser and semver precedence live in api-core's single
 * semver module (`@pipeline-builder/api-core` `utils/semver.ts`) and are
 * re-exported here unchanged, so this file holds only what needs drizzle: the
 * query builders' predicate over the `version` column ({@link versionSpecCondition})
 * and the semver ORDER BY ({@link semverOrderBy}). The JS and SQL matchers are
 * kept equivalent by the shared tests.
 */

import { parseVersionSpec, type SemverParts } from '@pipeline-builder/api-core';
import { and, asc, desc, eq, or, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';

export {
  compareSemverLenient,
  compareSemverParts,
  isVersionRange,
  maxSatisfying,
  parseSemver,
  parseVersionSpec,
  satisfiesVersionSpec,
  type SemverParts,
  type VersionSpec,
} from '@pipeline-builder/api-core';

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
