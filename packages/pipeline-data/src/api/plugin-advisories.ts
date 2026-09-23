// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Advisory matching: does a published advisory's `affectedRange` cover a given
 * version, and which advisories block a resolution under the org's policy.
 *
 * The range grammar is npm-style and deliberately re-implemented here rather
 * than pulled from `semver`: advisory ranges are OPERATOR SETS
 * (`>=1.0.0 <1.2.3`, `1.0.0 - 1.2.0`, `^1.2`, `1.x`, `||`), a different shape
 * from the install/reference version SPECS in ./semver-range.ts.
 */

import type { ConsumptionPolicy } from './plugin-consumption-policy.js';
import { compareSemver, parseSemver, parseVersionSpec, satisfiesVersionSpec } from './semver-range.js';
import type {
  AdvisorySeverity,
  BlockOnAdvisory,
  PluginAdvisory,
} from '../database/drizzle-schema.js';


/** Severities each `blockOnAdvisory` setting blocks. */
export const ADVISORY_BLOCK_SEVERITIES: Readonly<Record<BlockOnAdvisory, readonly AdvisorySeverity[]>> = {
  critical: ['critical'],
  high: ['critical', 'high'],
  never: [],
};

const COMPARATOR = /^(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** One comparator set (`>=1.0.0 <1.2.3`, `^1.2`, `1.x`, `1.0.0 - 1.2.0`) against `version`. */
function comparatorSetCovers(set: string, version: string): boolean {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen) return compareSemver(version, hyphen[1]!) >= 0 && compareSemver(version, hyphen[2]!) <= 0;
  const parts = set.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && parseVersionSpec(parts[0]!)) return satisfiesVersionSpec(version, parts[0]!);
  return parts.every((p) => {
    const m = COMPARATOR.exec(p);
    if (!m) return false;
    const c = compareSemver(version, m[2]!);
    switch (m[1] ?? '=') {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  });
}

/**
 * Whether an advisory's `affectedRange` covers `version`: `||`-separated
 * comparator sets, each either the lookup spec forms (`^`, `~`, partial,
 * exact) or space-separated comparators (`>=1.0.0 <1.2.3`) or a hyphen range.
 * `*` covers everything; an unparseable range covers nothing.
 */
export function advisoryRangeCovers(range: string, version: string): boolean {
  if (!parseSemver(version)) return false;
  return range.split('||').map((s) => s.trim()).some((set) => set === '*' || (set !== '' && comparatorSetCovers(set, version)));
}

/**
 * Why `range` isn't a usable advisory range (the forms {@link advisoryRangeCovers}
 * understands), or null when it is. An advisory whose range parses as nothing
 * would silently cover nothing, so drafts are refused instead.
 */
export function advisoryRangeProblem(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed === '') return 'the affected range is empty';
  if (trimmed.length > 255) return 'the affected range is longer than 255 characters';
  for (const set of trimmed.split('||').map((x) => x.trim())) {
    if (set === '*') continue;
    if (set === '') return 'the affected range has an empty "||" alternative';
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) {
      if (!parseSemver(hyphen[1]!) || !parseSemver(hyphen[2]!)) return `"${set}" is not a valid hyphen range`;
      continue;
    }
    const parts = set.split(/\s+/).filter(Boolean);
    if (parts.length === 1 && parts[0] !== 'latest' && parseVersionSpec(parts[0]!)) continue;
    const bad = parts.find((x) => !COMPARATOR.test(x));
    if (bad !== undefined) return `"${bad}" is not a version, a ^/~ range or a comparator (>=, <=, >, <, =)`;
  }
  return null;
}

/** The PUBLISHED advisories whose range covers `version` (any severity), most severe first. */
export function advisoriesCovering<A extends Pick<PluginAdvisory, 'severity' | 'state' | 'affectedRange'>>(
  advisories: readonly A[],
  version: string,
): A[] {
  const rank: Record<AdvisorySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return advisories
    .filter((a) => a.state === 'published' && advisoryRangeCovers(a.affectedRange, version))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The PUBLISHED advisories the policy blocks `version` for. */
export function blockingAdvisories(
  advisories: readonly Pick<PluginAdvisory, 'id' | 'severity' | 'state' | 'affectedRange' | 'fixedVersion' | 'summary'>[],
  version: string,
  policy: Pick<ConsumptionPolicy, 'blockOnAdvisory'>,
): Array<Pick<PluginAdvisory, 'id' | 'severity' | 'state' | 'affectedRange' | 'fixedVersion' | 'summary'>> {
  const severities = ADVISORY_BLOCK_SEVERITIES[policy.blockOnAdvisory];
  if (severities.length === 0) return [];
  return advisories.filter((a) => a.state === 'published' && severities.includes(a.severity) && advisoryRangeCovers(a.affectedRange, version));
}
