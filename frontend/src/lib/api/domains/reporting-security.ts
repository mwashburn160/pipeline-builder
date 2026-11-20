// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The advanced security reports (`GET /reports/security/*`): vulnerability
 * exposure / time to fix, and the compliance trend. `reports:read` +
 * `advanced_reporting`, org-scoped, rollup-aware, bucketed by `interval` / `tz` /
 * `weekStart` exactly like the `vulnerability_exposure` and `compliance_trend`
 * stakeholder sections, which compute the same numbers.
 */

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ReportBucketParams } from './reporting';
import type { ApiResponse } from '@/types';

/** One bucket of the new-vs-fixed series. `period` is a local wall-clock bucket start. */
export interface VulnTrendPoint {
  period: string;
  new: number;
  fixed: number;
}

export interface ExpiringAcceptance {
  pipelineId: string;
  pipelineName: string | null;
  plugin: string;
  version: string;
  acceptedUntil: string;
  daysLeft: number;
}

export interface VulnerabilityExposureReport {
  window: { from: string; to: string };
  /** When the open / KEV / expiring figures were taken: the range end, or now. */
  asOf: string;
  /** Plugin-image exposures open at `asOf`. Medium/low are always 0 (the rescan tracks Critical/High). */
  open: { exposures: number; pipelines: number; critical: number; high: number; medium: number; low: number; kev: number };
  /** The pipelines' own latest scanner reports (no history). */
  scanners: { reports: number; pipelines: number; critical: number; high: number; medium: number; low: number; kev: number };
  timeToFix: { n: number; medianSeconds: number | null; p90Seconds: number | null };
  trend: VulnTrendPoint[];
  totals: { new: number; fixed: number };
  expiringAcceptances: { count: number; items: ExpiringAcceptance[] };
}

export interface ComplianceTrendPoint {
  period: string;
  scans: number;
  pass: number;
  warn: number;
  block: number;
  exemptionsCreated: number;
  exemptionsActive: number;
}

export interface TopViolatedRule {
  ruleId: string;
  ruleName: string;
  severity: string | null;
  violations: number;
  entities: number;
}

export interface ComplianceTrendReport {
  window: { from: string; to: string };
  asOf: string;
  trend: ComplianceTrendPoint[];
  totals: { scans: number; pass: number; warn: number; block: number; exemptionsCreated: number };
  activeExemptions: number;
  topRules: TopViolatedRule[];
}

/** The query both reads take. */
export type SecurityReportParams = {
  from?: string;
  to?: string;
  interval?: 'day' | 'week' | 'month';
  includeDescendants?: boolean;
} & ReportBucketParams;

export function reportingSecurityApi(core: ApiCore) {
  return {
    /** Vulnerability exposure and time to fix. `advanced_reporting`. */
    getVulnerabilityExposure: async (params?: SecurityReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ vulnerabilities: VulnerabilityExposureReport }>>(
        `/api/reports/security/vulnerabilities${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.vulnerabilities ?? null;
    },

    /** Compliance trend: scan verdicts, exemptions, top violated rules. `advanced_reporting`. */
    getComplianceTrend: async (params?: SecurityReportParams, opts?: { signal?: AbortSignal }) => {
      const res = await core.request<ApiResponse<{ compliance: ComplianceTrendReport }>>(
        `/api/reports/security/compliance-trend${buildQuery(params)}`, { signal: opts?.signal },
      );
      return res.data?.compliance ?? null;
    },
  };
}
