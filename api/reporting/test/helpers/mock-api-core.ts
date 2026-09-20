// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring, the internal-service gate)
 * live in `@pipeline-builder/api-core/lib/testing/mock-api-core.js`. Only
 * reporting-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import {
  baseApiCoreMock,
  loggerMock,
  mockPermissionGate,
  serviceAuditDefaults,
  withInternalServiceGate,
} from '@pipeline-builder/api-core/lib/testing/mock-api-core.js';

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Reporting-specific defaults layered over the shared base. */
const reportingDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  // Billing toggle — reporting-retention's D8 gate reads it; default ON so the
  // sweep-scheduling suites behave as before. Suites override per-case.
  isBillingEnabled: () => true,
  // Faithful parseDateRange (mirrors api-core/utils/params): retention-cap.ts
  // imports it directly, so the base mock must export it.
  parseDateRange: (
    query: Record<string, unknown> = {},
    options: { maxRangeMs?: number; defaultDaysBack?: number } = {},
  ) => {
    const { maxRangeMs, defaultDaysBack = 30 } = options;
    const rawFrom = query.from;
    const rawTo = query.to;
    if (rawFrom !== undefined && typeof rawFrom !== 'string') return { error: '"from" must be a single ISO timestamp string' };
    if (rawTo !== undefined && typeof rawTo !== 'string') return { error: '"to" must be a single ISO timestamp string' };
    const now = Date.now();
    const fromStr = (rawFrom as string) ?? new Date(now - defaultDaysBack * 86_400_000).toISOString();
    const toStr = (rawTo as string) ?? new Date(now).toISOString();
    const fromMs = Date.parse(fromStr);
    const toMs = Date.parse(toStr);
    if (!Number.isFinite(fromMs)) return { error: '"from" is not a valid ISO timestamp' };
    if (!Number.isFinite(toMs)) return { error: '"to" is not a valid ISO timestamp' };
    if (fromMs > toMs) return { error: '"from" must be earlier than "to"' };
    if (maxRangeMs !== undefined && toMs - fromMs > maxRangeMs) {
      return { error: `Date range exceeds maximum of ${Math.floor(maxRangeMs / 86_400_000)} days` };
    }
    return { from: fromStr, to: toStr };
  },
  // RBAC read-permission gate factories. Behavioral so the index-wiring suite
  // can assert 403-vs-pass; provided by default so any suite loading src/index.ts
  // (which imports requirePermission) links.
  requirePermission: mockPermissionGate({ onAnonymous: '401', shape: 'error' }),
  requirePermissionOrService: mockPermissionGate({ onAnonymous: '401', shape: 'error', allowService: true }),
  // Feature-entitlement gate factory (DORA routes use requireFeature).
  requireFeature: (_feature: string) => (_req: any, _res: any, next: any) => next && next(),
  // Pagination + validation helpers used by the incident/settings routes.
  sendPaginatedNested: (_res: any, key: string, data: unknown, options: unknown) => ({ [key]: data, pagination: options }),
  parsePaginationParams: (q: Record<string, unknown>) => ({
    limit: Number(q?.limit) > 0 ? Number(q.limit) : 100,
    offset: Number(q?.offset) > 0 ? Number(q.offset) : 0,
  }),
  validateBody: (req: any, schema: any) => {
    const r = schema.safeParse(req?.body);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, error: r.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  },
  // Shared org-descendants resolver imported by src/helpers/report-helpers.ts.
  fetchOrgDescendants: jest.fn(),
});

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...reportingDefaults(), ...overrides };
  return withInternalServiceGate(baseApiCoreMock(actualApiCore, merged), overrides);
}
