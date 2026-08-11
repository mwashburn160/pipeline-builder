// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `@pipeline-builder/api-core` mock for ESM suites.
 *
 * Collapses the factory that every suite passed to
 * `jest.unstable_mockModule('@pipeline-builder/api-core', () => ({ ... }))`.
 * Provides the winston-logger stub plus the api-core runtime VALUES that the
 * transitively loaded pipeline-core / pipeline-data graph imports — under
 * transpile-only/`verbatimModuleSyntax` those stay real imports, so the mock
 * must expose them or ESM linking against it throws "does not provide an
 * export named X". Pass `overrides` for the exports a given suite exercises
 * (spies it asserts on, a bespoke error class, a stateful cache, etc.).
 */
import { jest } from '@jest/globals';

/** No-op guard: the mock covers route wiring, not the auth/permission gate. */
const passThroughMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();

/** The 4-method logger stub every suite repeats; a fresh set of spies per call. */
export const loggerMock = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/** Mirrors api-core: `ErrorCode.ANY_CODE` resolves to the string `'ANY_CODE'`. */
const ErrorCode = new Proxy({}, { get: (_t, key) => key }) as Record<string, string>;

/** Mirrors api-core's NotFoundError (statusCode 404 / code NOT_FOUND). */
class NotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';
  constructor(message?: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Mirrors api-core's ValidationError (statusCode 400 / code VALIDATION_ERROR). */
class ValidationError extends Error {
  statusCode = 400;
  code = 'VALIDATION_ERROR';
  constructor(message?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createLogger: loggerMock,
    SYSTEM_ORG_ID: '000000000000000000000001',
    // S2S token minter — routes forward a service token (not the user bearer)
    // to quota/compliance. Suites that assert on the forwarded auth override this.
    getServiceAuthHeader: () => 'Bearer service-token',
    // Remote audit client factory — the pipeline routes' audit wiring
    // (src/services/audit.ts) links against this. Default returns a no-op
    // recorder; suites asserting on emitted audit events mock the audit module
    // (src/services/audit.js) directly instead.
    createRemoteAuditClient: () => ({ record: jest.fn() }),
    createEnvRedisAuditSpool: () => null,
    // Service audit factory — src/services/audit.ts now links against this. Returns
    // the ServiceAuditClient shape: `emit` + a spool-backed `client` (RemoteAuditClient).
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    // #5 failed-authz auditor registration (src/index.ts) — no-op in suites.
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    // Token-revocation reader hooks (session-invalidation) — stubbed for parity
    // so suites that transitively load the boot module still link.
    setTokenRevocationStore: () => {},
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    extractDbError: () => ({}),
    // Real account-id scrub (mirrors api-core's aws-scrub): 12-digit runs → [REDACTED].
    // Services that link this at the persistence/response boundary need the real
    // behavior so suites can assert account ids never leak.
    scrubAwsIdentifiersFromString: (input: string) =>
      String(input).replace(/(?<!\d)\d{12}(?!\d)/g, '[REDACTED]'),
    // `requirePermission(...perms)` is a factory that RETURNS middleware, so
    // the stub is a function producing the pass-through guard.
    requirePermission: () => passThroughMiddleware,
    // `requireFeature(feature)` — same factory shape. Suites asserting the
    // feature gate itself override this with a capability/feature-aware stub.
    requireFeature: () => passThroughMiddleware,
    NotFoundError,
    ValidationError,
    // Pipeline-template Zod schemas — the template routes import them as values
    // (passed to validateBody/validateQuery). Inert stubs suffice for ESM linking;
    // suites that exercise validation override validateBody/validateQuery anyway.
    PipelineTemplateFilterSchema: {},
    PipelineTemplateCreateSchema: {},
    PipelineTemplateUpdateSchema: {},
    InstantiateTemplateSchema: {},
    // Shared SSRF guard — git-analysis http.ts links against this. Default is a
    // permissive async no-op; suites exercising the guard override it.
    assertSafeUrl: async () => {},
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      invalidatePattern: () => Promise.resolve(0),
    }),
    ...overrides,
  };
}
