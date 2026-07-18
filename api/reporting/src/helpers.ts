// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, fetchOrgDescendants } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

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
 * tree). Returns `undefined` when there's no parent/child hierarchy, or on ANY
 * error — callers then fall back to the normal single-org report. This makes
 * the rollup a best-effort enhancement that can never break a report.
 *
 * The HTTP mechanics (platform host/port resolution, the signed service-token
 * auth header, timeout+retry, and element-level validation of the returned id
 * list) live in the shared api-core `fetchOrgDescendants` helper — the same
 * sanctioned service-to-service org resolver compliance uses via
 * `fetchParentOrgId`. This function only keeps reporting's fail-soft policy.
 */
export async function resolveOrgRollup(orgId: string): Promise<string[] | undefined> {
  try {
    const { services } = Config.get('server');
    return await fetchOrgDescendants(orgId, {
      service: { host: services.platformHost, port: services.platformPort },
      serviceName: 'reporting',
      headers: { 'x-org-id': orgId },
      timeout: 3000,
    });
  } catch (err) {
    _descLogger.warn('Org rollup resolution failed; falling back to single-org report', { orgId, err: String(err) });
    return undefined;
  }
}
