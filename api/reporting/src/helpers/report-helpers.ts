// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, envInt, fetchOrgDescendants, RETENTION_MAX_DAYS, userHasPermission } from '@pipeline-builder/api-core';
import type { Request } from 'express';

const _descLogger = createLogger('reporting-rollup');

/**
 * Timeout (ms) for reporting's outbound platform org-hierarchy lookups
 * (env: `REPORTING_HTTP_TIMEOUT`).
 *
 * Deliberately TIGHTER than the global `HTTP_CLIENT_TIMEOUT` (5s): both callers
 * sit in front of a user-facing report or a batched retention sweep where a
 * hierarchy lookup is a best-effort enhancement — failing fast and degrading to
 * a single-org report (or skipping the org this tick) beats holding the request
 * for the full global budget.
 */
export const REPORTING_HTTP_TIMEOUT_MS = envInt('REPORTING_HTTP_TIMEOUT', 3000, { min: 1 });

// Interval validation MUST happen at the route layer (against REPORT_INTERVALS):
// ReportingService interpolates the value directly into `DATE_TRUNC(${interval}, ...)`,
// so an unvalidated string would be a raw-SQL injection vector. The service-side
// check is defense-in-depth — the route is the security boundary.

export const MAX_REPORT_LIMIT = 1000;
// The absolute retention ceiling bounds every report range. A per-org effective
// window (tier baseline + purchased retention bundles) narrows it per request via
// `resolveOrgRetentionWindow`; an unlimited (`-1`) org — and the system-admin
// cross-org reports — clamp to the ceiling itself.
export const MAX_REPORT_RANGE_MS = RETENTION_MAX_DAYS * 24 * 60 * 60 * 1000;

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
 * Return a copy of each row with `key`'s free-text error value scrubbed of
 * credentials. Centralizes the `as unknown as Record<...>[]` cast the admin
 * error/failure reports each hand-rolled (differing only in the field name).
 */
export function scrubField<T>(rows: readonly T[], key: string): Array<Record<string, unknown>> {
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    [key]: scrubErrorMessage(r[key] as string | null | undefined),
  }));
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
    return await fetchOrgDescendants(orgId, {
      headers: { 'x-org-id': orgId },
      timeout: REPORTING_HTTP_TIMEOUT_MS,
    });
  } catch (err) {
    _descLogger.warn('Org rollup resolution failed; falling back to single-org report', { orgId, err: String(err) });
    return undefined;
  }
}

/**
 * Resolve the org-id set a rollup-aware report should span for this request.
 *
 * `?includeDescendants=true` rolls a parent org's report up over its team
 * subtree (via {@link resolveOrgRollup}). SECURITY: downward (parent → child)
 * visibility is a granted capability — org members get no inherited view of
 * their teams (matches the RBAC model), so the flag is honored only for callers
 * holding `reports:rollup` (built-in Admin/Owner bundles + superadmin-implicit-all;
 * grantable to a custom Role). Everyone else silently gets their own-org report
 * (returns `undefined` → single-org).
 *
 * Shared by the execution + plugin report routers so the two authz gates can
 * never drift — a divergence would be an authorization bug.
 */
export function rollupIds(req: Request, orgId: string): Promise<string[] | undefined> {
  const canRollup = userHasPermission(req, 'reports:rollup');
  return req.query.includeDescendants === 'true' && canRollup
    ? resolveOrgRollup(orgId)
    : Promise.resolve(undefined);
}
