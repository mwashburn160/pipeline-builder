// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared vocabulary for security advisories (plan W8): severity order and
 * colours, state / source labels, and the CVE-id parser the advisory forms use.
 */

import type { AdvisorySeverity, AdvisorySource, AdvisoryState } from '@/types/ecosystem';

type BadgeColor = 'green' | 'red' | 'gray' | 'blue' | 'purple' | 'yellow' | 'indigo';

export const ADVISORY_SEVERITIES: AdvisorySeverity[] = ['critical', 'high', 'medium', 'low'];

export const SEVERITY_LABELS: Record<AdvisorySeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** Rank for sorting — lower is more severe; unknown severities sort last. */
export function severityRank(severity: string): number {
  const i = ADVISORY_SEVERITIES.indexOf(severity.toLowerCase() as AdvisorySeverity);
  return i === -1 ? ADVISORY_SEVERITIES.length : i;
}

/** Highest severity first (stable for equal severities). */
export function sortBySeverity<T extends { severity: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export function severityColor(severity: string): BadgeColor {
  const rank = severityRank(severity);
  if (rank <= 1) return 'red';
  if (rank === 2) return 'yellow';
  return 'gray';
}

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity.toLowerCase() as AdvisorySeverity] ?? severity;
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
