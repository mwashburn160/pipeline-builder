// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring) live in
 * `@pipeline-builder/api-core/testing`. Only
 * plugin-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import {
  MockAppError,
  MockConflictError,
  MockForbiddenError,
  MockNotFoundError,
  MockValidationError,
  baseApiCoreMock,
  loggerMock,
  passThroughMiddleware,
  serviceAuditDefaults,
} from '@pipeline-builder/api-core/testing';
import { z } from 'zod';

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

/** Plugin-specific defaults layered over the shared base. */
const pluginDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  /** Real zod enum so route modules that build `z.object({ visibility: VisibilitySchema… })`
   *  at load time link against the mock (mirrors api-core's `VisibilitySchema`). */
  VisibilitySchema: z.enum(['private', 'org', 'public']),
  loadAndPurge: async () => null,
  getParam: (params: Record<string, string>, key: string) => params?.[key],
  // Route-response + access helpers, so a test that mounts the REAL index.js
  // (full route graph) resolves them without re-stubbing each one.
  // Real signature: (req, res, resource, userId, perm) => boolean — true lets the
  // write proceed, false means it already sent the 403. Default: allowed.
  requireVisibilityWriteAccess: () => true,
  sendSuccess: (res: any, statusCode: number, data?: unknown) => res.status(statusCode).json({ success: true, statusCode, data }),
  sendBadRequest: (res: any, message: string) => res.status(400).json({ success: false, message }),
  sendError: (res: any, statusCode: number, message: string) => res.status(statusCode).json({ success: false, message }),
  sendEntityNotFound: (res: any, entity?: string) => res.status(404).json({ success: false, message: `${entity ?? 'Entity'} not found` }),
  // `requirePermission(...perms)` is a factory that RETURNS middleware, so
  // the stub is a function producing the pass-through guard.
  requirePermission: () => passThroughMiddleware,
  requireFeature: () => passThroughMiddleware,
  // Compliance client — upload AND update routes gate on it (fail-closed).
  createComplianceClient: () => ({
    validatePlugin: async () => ({ blocked: false, violations: [] }),
  }),
  getServiceAuthHeader: () => 'Bearer service-token',
  AppError: MockAppError,
  NotFoundError: MockNotFoundError,
  ValidationError: MockValidationError,
  ForbiddenError: MockForbiddenError,
  ConflictError: MockConflictError,
  // Caller-authority probes the create/upload overwrite gate snapshots.
  isSystemAdmin: () => false,
  userHasPermission: () => false,
  // Mirrors api-core: 503 (+Retry-After) when the quota service couldn't
  // confirm the reservation, 429 when the org is actually over its limit.
  sendQuotaReserveDenied: (res: any, _type: string, reservation: { unavailable?: boolean; quota?: unknown }) =>
    reservation.unavailable
      ? res.status(503).json({ success: false, statusCode: 503, code: 'SERVICE_UNAVAILABLE' })
      : res.status(429).json({ success: false, statusCode: 429, quota: reservation.quota }),
});

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...pluginDefaults(), ...overrides });
}
