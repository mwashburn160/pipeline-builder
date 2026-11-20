// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyed copy catalogs for the reports UI: the failure-category labels and the
 * "why is lead time unknown, and how do I fix it" hints. Data rather than
 * switches, so a new key is one line and a missing one falls back visibly.
 */

import type { LeadTimeGap } from '@/lib/api/domains/reporting';

/**
 * Failure-category labels. Mirrors pipeline-data's `FAILURE_CATEGORY_LABELS`
 * (the report and the dashboard must name a category the same way).
 */
export const FAILURE_CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  source_checkout: 'Source checkout',
  dependency: 'Dependency resolution',
  build: 'Build / compile',
  unit_test: 'Unit tests',
  integration_test: 'Integration tests',
  security_scan: 'Security scan',
  infrastructure: 'Cloud infrastructure',
  deployment: 'Deployment',
  authentication: 'Authentication',
  permissions: 'Permissions',
  configuration: 'Configuration',
  timeout: 'Timeout',
  resource_exhaustion: 'Out of resources',
  external_service: 'External service',
  other: 'Unclassified',
});

/** A category's label; an id this build does not know reads as itself, not as blank. */
export function failureCategoryLabel(category: string): string {
  return FAILURE_CATEGORY_LABELS[category] ?? category;
}

/** What an unknown-lead-time reason means, and the one thing that fixes it. */
export interface LeadTimeGapCopy {
  label: string;
  fix: string;
}

/** Every stored `lead_time_gap` reason → its reader-facing cause and fix. */
export const LEAD_TIME_GAP_COPY: Readonly<Record<LeadTimeGap, LeadTimeGapCopy>> = Object.freeze({
  no_token: {
    label: 'No SCM token',
    fix: 'Store a github-token secret in the AWS account the events forwarder runs in, so it can read the commit range.',
  },
  rate_limited: {
    label: 'SCM rate-limited',
    fix: 'The provider rate-limited the commit-range lookup. It recovers on its own; a token with a higher rate limit stops it recurring.',
  },
  unsupported_source: {
    label: 'Source has no commit-range API',
    fix: 'This source type cannot report a commit range, so lead time cannot be measured for it. Use a GitHub source for these pipelines.',
  },
  no_commit_data: {
    label: 'No commit data reported',
    fix: 'Turn on commit resolution: pipeline-manager infra setup-events --scoped-ingest --with-dora.',
  },
});

/** Order the reasons are listed in: most deploys first, then the catalog order. */
const GAP_ORDER = Object.keys(LEAD_TIME_GAP_COPY) as LeadTimeGap[];

/**
 * The tooltip for an unknown lead time: one line per reason that occurred, with
 * its count and fix. Null when no reason was recorded (an older backend, or
 * every deploy was measured).
 */
export function leadTimeGapTooltip(reasons: Partial<Record<LeadTimeGap, number>> | undefined): string | null {
  const rows = GAP_ORDER
    .map((k) => [k, reasons?.[k] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  return rows
    .map(([k, n]) => `${LEAD_TIME_GAP_COPY[k].label} (${n} deploy${n === 1 ? '' : 's'}): ${LEAD_TIME_GAP_COPY[k].fix}`)
    .join(' ');
}

/** The pipeline's Runs tab — where a failure or a flake row sends the reader. */
export function pipelineRunsHref(pipelineId: string): string {
  return `/dashboard/pipelines/${encodeURIComponent(pipelineId)}?tab=runs`;
}

/** The help-center topic the DORA "How these are counted" note links to. */
export const DORA_HELP_HREF = '/dashboard/help#topic-dora-metrics';
