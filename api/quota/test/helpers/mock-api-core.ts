// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Quota's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring, the `requireInternalService`
 * gate) live in `@pipeline-builder/api-core/lib/testing/mock-api-core.js` — see
 * that module for why the deep path is safe inside a suite that mocks the barrel.
 * Only quota-specific defaults belong here.
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

/**
 * RBAC read-permission gate factories. Behavioral so gate suites can assert
 * 403-vs-pass; provided by default so read-quotas.ts (which imports both) links
 * in every suite. Handler-only suites skip these middleware layers.
 */
const requirePermission = mockPermissionGate({ onAnonymous: '401', shape: 'error' });
const requirePermissionOrService = mockPermissionGate({ onAnonymous: '401', shape: 'error', allowService: true });

/** Quota-specific defaults layered over the shared base. */
const quotaDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  requirePermission,
  requirePermissionOrService,
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...quotaDefaults(), ...overrides };
  return withInternalServiceGate(baseApiCoreMock(actualApiCore, merged), merged);
}
