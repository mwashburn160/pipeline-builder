// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, fetchOrgDescendants, userHasPermission } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import type { Request } from 'express';

const _descLogger = createLogger('reporting-rollup');

// Interval validation MUST happen at the route layer (against REPORT_INTERVALS):
// ReportingService interpolates the value directly into `DATE_TRUNC(${interval}, ...)`,
// so an unvalidated string would be a raw-SQL injection vector. The service-side
// check is defense-in-depth — the route is the security boundary.

export const MAX_REPORT_LIMIT = 1000;
// Absolute retention ceiling (days). A per-org effective window (tier baseline +
// purchased retention bundles) narrows this per request via
// `resolveOrgRetentionWindow`; this constant is the hard ceiling an `-1` (unlimited)
// org — and the system-admin cross-org reports — clamp to.
export const MAX_REPORT_RANGE_DAYS = 730;
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
