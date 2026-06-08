// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getServiceAuthHeader } from '@pipeline-builder/api-core';

const _descLogger = createLogger('reporting-rollup');

// Interval validation MUST happen at the route layer (against REPORT_INTERVALS):
// ReportingService interpolates the value directly into `DATE_TRUNC(${interval}, ...)`,
// so an unvalidated string would be a raw-SQL injection vector. The service-side
// check is defense-in-depth — the route is the security boundary.

export const MAX_REPORT_LIMIT = 1000;
export const MAX_REPORT_RANGE_DAYS = 365;
export const MAX_REPORT_RANGE_MS = MAX_REPORT_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** Patterns that match common credential leakage in error messages. */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /AWS_[A-Z_]+=[\S]+/g,
  /(password|secret|token|key)[\s:=]+\S+/gi,
];

/** Redact credential-shaped substrings from a failure/error message. */
export function scrubErrorMessage(msg: string | null | undefined): string | null | undefined {
  if (!msg) return msg;
  return CREDENTIAL_PATTERNS.reduce((acc, re) => acc.replace(re, '[REDACTED]'), msg);
}

/**
 * Org → team rollup: resolve `[self, ...descendantOrgIds]` for `orgId` by
 * calling the platform's authoritative descendants endpoint (it owns the org
 * tree). Returns `undefined` when there's no parent/child hierarchy, when
 * `PLATFORM_BASE_URL` is unset, or on ANY error — callers then fall back to the
 * normal single-org report. This makes the rollup a best-effort enhancement
 * that can never break a report.
 */
export async function resolveOrgRollup(orgId: string): Promise<string[] | undefined> {
  const base = process.env.PLATFORM_BASE_URL;
  if (!base) return undefined;
  try {
    const url = `${base.replace(/\/$/, '')}/api/organization/${encodeURIComponent(orgId)}/descendants`;
    const res = await fetch(url, {
      headers: { 'Authorization': getServiceAuthHeader({ serviceName: 'reporting', orgId, role: 'owner' }), 'x-org-id': orgId },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { data?: { orgIds?: unknown } };
    const ids = body?.data?.orgIds;
    // Only meaningful when the subtree is larger than the org itself.
    return Array.isArray(ids) && ids.length > 1 ? (ids as string[]) : undefined;
  } catch (err) {
    _descLogger.warn('Org rollup resolution failed; falling back to single-org report', { orgId, err: String(err) });
    return undefined;
  }
}
