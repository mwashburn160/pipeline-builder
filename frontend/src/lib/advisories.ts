// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared vocabulary for security advisories: severity order and
 * colours, state / source labels, and the CVE-id parser the advisory forms use.
 */

import { ADVISORY_SEVERITIES } from '@pipeline-builder/api-core/wire-vocabulary';
import type { BadgeColor } from '@/components/ui/Badge';
import type { AdvisorySeverity, AdvisorySource, AdvisoryState } from '@/types/ecosystem';


/**
 * Every advisory severity: its label and badge colour. api-core's
 * `ADVISORY_SEVERITIES` is most severe first, and that order IS the severity
 * rank (`severityRank`).
 */
export const ADVISORY_SEVERITY_META = {
  critical: { label: 'Critical', color: 'red' },
  high: { label: 'High', color: 'red' },
  medium: { label: 'Medium', color: 'yellow' },
  low: { label: 'Low', color: 'gray' },
} as const satisfies Record<AdvisorySeverity, { label: string; color: BadgeColor }>;

function asAdvisorySeverity(severity: string): AdvisorySeverity | null {
  const s = severity.toLowerCase();
  return Object.hasOwn(ADVISORY_SEVERITY_META, s) ? (s as AdvisorySeverity) : null;
}

/** Rank for sorting — lower is more severe; unknown severities sort last. */
export function severityRank(severity: string): number {
  const known = asAdvisorySeverity(severity);
  return known ? ADVISORY_SEVERITIES.indexOf(known) : ADVISORY_SEVERITIES.length;
}

/** Highest severity first (stable for equal severities). */
export function sortBySeverity<T extends { severity: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** Badge colour for a severity off the wire; an unknown one is neutral. */
export function severityColor(severity: string): BadgeColor {
  const known = asAdvisorySeverity(severity);
  return known ? ADVISORY_SEVERITY_META[known].color : 'gray';
}

/** Label for a severity off the wire; an unknown one is shown raw. */
export function severityLabel(severity: string): string {
  const known = asAdvisorySeverity(severity);
  return known ? ADVISORY_SEVERITY_META[known].label : severity;
}

export const ADVISORY_STATE_LABELS: Record<AdvisoryState, string> = {
  draft: 'Draft',
  published: 'Published',
  withdrawn: 'Withdrawn',
};

export const ADVISORY_STATE_COLORS: Record<AdvisoryState, BadgeColor> = {
  draft: 'yellow',
  published: 'red',
  withdrawn: 'gray',
};

export const ADVISORY_SOURCE_LABELS: Record<AdvisorySource, string> = {
  publisher: 'Publisher',
  moderator: 'Moderator',
  cve_rescan: 'CVE rescan',
  review: 'Review',
};

export const ADVISORY_SUMMARY_MAX = 300;

/** CVE ids typed comma- or whitespace-separated, upper-cased and de-duplicated. */
export function parseCveIds(text: string): string[] {
  const ids = text.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Client-side checks, mirroring the server's (`parseAdvisoryFields`,
// `advisoryRangeProblem`, `parseVulnIds`) so a malformed draft is caught in the
// form — before a step-up is spent on a request the server can only refuse.
// ---------------------------------------------------------------------------

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR = /^(>=|<=|>|<|=)?\s*v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** `^1.2.3`, `~1.2`, `1`, `1.x`, `1.2.*`, an exact version. */
const SPEC = /^[\^~]?v?\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/;
const VULN_ID = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]{1,60}$/;
/** The server's cap on ids per advisory. */
export const ADVISORY_MAX_IDS = 50;

/** Whether `v` is a full semver version. */
export function isSemverVersion(v: string): boolean {
  return SEMVER.test(v.trim());
}

/** Why `range` isn't an advisory range the server accepts, or null when it is. */
export function advisoryRangeProblem(range: string): string | null {
  const trimmed = range.trim();
  if (trimmed === '') return 'The affected range is empty.';
  if (trimmed.length > 255) return 'The affected range is longer than 255 characters.';
  for (const set of trimmed.split('||').map((x) => x.trim())) {
    if (set === '*') continue;
    if (set === '') return 'The affected range has an empty "||" alternative.';
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
    if (hyphen) {
      if (!isSemverVersion(hyphen[1]!) || !isSemverVersion(hyphen[2]!)) return `"${set}" is not a valid hyphen range.`;
      continue;
    }
    const parts = set.split(/\s+/).filter(Boolean);
    if (parts.length === 1 && parts[0] !== 'latest' && SPEC.test(parts[0]!)) continue;
    const bad = parts.find((x) => !COMPARATOR.test(x));
    if (bad !== undefined) return `"${bad}" is not a version, a ^/~ range or a comparator (>=, <=, >, <, =).`;
  }
  return null;
}

/** Why the CVE/GHSA id list would be refused, or null. */
export function vulnIdsProblem(text: string): string | null {
  const ids = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bad = ids.find((id) => !VULN_ID.test(id));
  if (bad) return `"${bad.slice(0, 80)}" is not a vulnerability id (e.g. CVE-2026-1234 or GHSA-xxxx-xxxx-xxxx).`;
  if (new Set(ids.map((i) => i.toUpperCase())).size > ADVISORY_MAX_IDS) return `At most ${ADVISORY_MAX_IDS} vulnerability ids per advisory.`;
  return null;
}
