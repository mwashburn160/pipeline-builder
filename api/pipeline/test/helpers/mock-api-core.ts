// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring) live in
 * `@pipeline-builder/api-core/testing`. Only
 * pipeline-specific defaults belong here.
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

/** Pipeline-specific defaults layered over the shared base. */
const pipelineDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  loadAndPurge: async () => null,
  // The `openai-compatible` (local model) provider is deployment-defined; ai-core's
  // provider-registry imports these from api-core, so the mock must expose them.
  OPENAI_COMPATIBLE_PROVIDER_ID: 'openai-compatible',
  getOpenAICompatibleProvider: () => null,
  // S2S token minter — routes forward a service token (not the user bearer)
  // to quota/compliance. Suites that assert on the forwarded auth override this.
  getServiceAuthHeader: () => 'Bearer service-token',
  // Compliance client — create AND update routes gate on it (fail-closed).
  // Default is non-blocking; a suite testing a compliance block overrides it.
  createComplianceClient: () => ({
    validatePipeline: async () => ({ blocked: false, violations: [] }),
    validatePlugin: async () => ({ blocked: false, violations: [] }),
  }),
  extractDbError: () => ({}),
  // Real account-id scrub (mirrors api-core's aws-scrub): 12-digit runs → [REDACTED].
  scrubAwsIdentifiersFromString: (input: string) =>
    String(input).replace(/(?<!\d)\d{12}(?!\d)/g, '[REDACTED]'),
  // `requirePermission(...perms)` is a factory that RETURNS middleware, so
  // the stub is a function producing the pass-through guard.
  requirePermission: () => passThroughMiddleware,
  requireFeature: () => passThroughMiddleware,
  AppError: MockAppError,
  NotFoundError: MockNotFoundError,
  ValidationError: MockValidationError,
  ForbiddenError: MockForbiddenError,
  ConflictError: MockConflictError,
  // Template visibility gates — the pipeline-template routes link against
  // these. Defaults allow the write and echo the requested rung.
  requireVisibilityWriteAccess: () => true,
  resolveVisibility: (_req: unknown, requested?: string) =>
    (requested === 'public' || requested === 'org' ? requested : 'private'),
  // Pipeline-template Zod schemas — the template routes import them as values.
  PipelineTemplateFilterSchema: {},
  PipelineTemplateCreateSchema: {},
  PipelineTemplateUpdateSchema: {},
  InstantiateTemplateSchema: {},
  // Shared SSRF guard — git-analysis http.ts links against this.
  assertSafeUrl: async () => {},
  // Env Redis client factory — returns null (no Redis) so consumers like the
  // execution-idempotency guard fail open in suites.
  createEnvRedisClient: () => null,
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
  return baseApiCoreMock(actualApiCore, { ...pipelineDefaults(), ...overrides });
}
