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

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createLogger: loggerMock,
    // Shared attachment bounds (used by attachment-routes' multer setup).
    MESSAGE_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
    MESSAGE_ATTACHMENT_ALLOWED_MIME: new Set([
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'application/pdf', 'text/plain', 'text/csv', 'application/json',
    ]),
    // Mirror the real isAllowedAttachmentType: MIME allow-list, plus a safe-
    // extension fallback for the generic application/octet-stream.
    isAllowedAttachmentType: (mimetype: string, filename: string): boolean => {
      const mime = new Set([
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf',
        'text/plain', 'text/csv', 'application/json', 'text/json',
        'application/zip', 'application/x-zip-compressed', 'application/gzip',
        'application/x-gzip', 'application/x-tar', 'application/tar',
        'application/x-compressed-tar', 'application/x-yaml', 'application/yaml',
        'text/yaml', 'text/x-yaml',
      ]);
      if (mime.has(mimetype)) return true;
      if (mimetype !== 'application/octet-stream') return false;
      const i = (filename || '').lastIndexOf('.');
      if (i < 0) return false;
      const ext = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.zip', '.gz', '.tgz', '.tar', '.json', '.yaml', '.yml',
      ]);
      return ext.has(filename.slice(i).toLowerCase());
    },
    MAX_PAGE_LIMIT: 1000,
    DEFAULT_PAGE_LIMIT: 100,
    closeLeaderLock: async () => undefined,
    loadAndRestore: async () => null,
    REPORT_INTERVALS: ['day', 'week', 'month'],
    scrubAwsIdentifiersFromString: (s: string) => s,
    scrubAwsIdentifiers: <T>(v: T): T => v,
    createScheduler: () => ({ start: () => undefined, stop: () => undefined }),
    createEnvRedisLock: () => null,
    requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
    SYSTEM_ORG_ID: '000000000000000000000001',
    AccessModifier: { PUBLIC: 'public', PRIVATE: 'private' },
    ComputeType: { SMALL: 'SMALL', MEDIUM: 'MEDIUM', LARGE: 'LARGE', X2_LARGE: 'X2_LARGE' },
    PluginType: { CODE_BUILD_STEP: 'CodeBuildStep', SHELL_STEP: 'ShellStep', MANUAL_APPROVAL_STEP: 'ManualApprovalStep' },
    ErrorCode,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // `requirePermission(...perms)` / `requirePermissionOrService(...perms)` are
    // factories that RETURN middleware, so each stub is a function producing the
    // pass-through guard. Suites exercising the gate override these with real
    // 403-unless-permitted semantics.
    requirePermission: () => passThroughMiddleware,
    requirePermissionOrService: () => passThroughMiddleware,
    // Remote audit client factory — kept for any module still linking it directly.
    createRemoteAuditClient: () => ({ record: () => {} }),
    createEnvRedisAuditSpool: () => null,
    // Service audit factory — src/services/audit.ts now links against this. Returns
    // the ServiceAuditClient shape: `emit` + a spool-backed `client` (RemoteAuditClient).
    createServiceAuditClient: () => ({ emit: jest.fn(), client: { record: jest.fn() } }),
    createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
    // #5 failed-authz auditor registration (src/index.ts) — no-op in suites.
    setAuthzDenialAuditor: () => {},
    wireAuthzDenialAuditor: () => {},
    wireServiceSecurity: () => {},
    // Token-revocation reader hooks (session-invalidation) — stubbed for parity
    // so suites that transitively load the boot module still link.
    setTokenRevocationStore: () => {},
    createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
    NotFoundError,
    createCacheService: () => ({
      getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
      get: async () => null,
      set: async () => undefined,
      invalidatePattern: () => Promise.resolve(0),
    }),
    // Org id→name enrichment (org-names helper) — resolve to "no names" so route
    // suites fall back to the raw id, exactly like a platform lookup miss.
    fetchOrgNames: async () => ({}),
    ...overrides,
  };
}
