// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, the service gates) live in
 * `@pipeline-builder/api-core/lib/testing/mock-api-core.js`. Only
 * compliance-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import {
  MockConflictError,
  baseApiCoreMock,
  loggerMock,
  passThroughMiddleware,
  withInternalServiceGate,
  withServicePrincipalGate,
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

/** Compliance-specific defaults layered over the shared base. */
const complianceDefaults = (): Record<string, unknown> => ({
  isSystemOrgId: (orgId?: string) => orgId === '000000000000000000000001',
  // Module-load tunables (scan batch sizes, regex cap, …). Reads the env like
  // the real helper so a suite can set e.g. COMPLIANCE_SCAN_ENTITY_PAGE_SIZE.
  envInt: (name: string, def: number) => {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) ? n : def;
  },
  // Default no-op so route modules importing `sendError` link under ESM. A
  // suite asserting on responses can override with its own res-writing spy.
  sendError: jest.fn(),
  // `requirePermission(...perms)` is a factory that RETURNS middleware, so
  // the stub is a function producing the pass-through guard.
  requirePermission: () => passThroughMiddleware,
  requireFeature: () => passThroughMiddleware,
  // Service audit accessor — src/services/audit.ts links against this.
  // Suites asserting `authz.denied` wire api-core's real sink instead.
  createRemoteAuditAccessor: () => ({ getAuditClient: () => ({ record: jest.fn() }), emit: jest.fn() }),
  wireServiceSecurity: () => {},
  // boot-time token-revocation reader registration (session-invalidation
  // option b) — stubbed so suites that transitively load the boot module link.
  setTokenRevocationStore: () => {},
  createRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
  createEnvRedisTokenRevocationStore: () => ({ getCurrentVersion: async () => null }),
  ConflictError: MockConflictError,
  // Link-only defaults for modules that import these at load (webhook SSRF
  // guard, compliance-attribute projection). Suites exercising them import the
  // real implementations instead.
  isPrivateAddress: () => false,
  toComplianceAttributes: <T>(v: T): T => v,
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...complianceDefaults(), ...overrides };
  const mock = baseApiCoreMock(actualApiCore, merged);
  withServicePrincipalGate(mock, overrides);
  withInternalServiceGate(mock, overrides);
  return mock;
}
