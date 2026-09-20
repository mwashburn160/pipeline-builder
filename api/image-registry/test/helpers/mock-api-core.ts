// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * image-registry's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants, audit/boot wiring, the permission gate) live in
 * `@pipeline-builder/api-core/lib/testing/mock-api-core.js`. Only
 * image-registry-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import {
  baseApiCoreMock,
  loggerMock,
  mockPermissionGate,
  serviceAuditDefaults,
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

/** image-registry-specific defaults layered over the shared base. */
const imageRegistryDefaults = (): Record<string, unknown> => ({
  ...serviceAuditDefaults(),
  getServiceAuthHeader: (o: { serviceName: string }) => `Bearer service-token-for-${o.serviceName}`,
  // Permission gates the /api/images + /api/admin routes attach per-route.
  // Capability-aware: no req.user ⇒ pass (suites with no auth layer keep
  // working); superadmin ⇒ pass; else check req.user.permissions.
  requirePermission: mockPermissionGate({ mode: 'some' }),
  requireAllPermissions: mockPermissionGate({ mode: 'every' }),
  // Zod body validation used by the copy + GC routes. Mirrors api-core's
  // `validate`: `{ ok, value }` or `{ ok: false, error }` naming the FIRST issue.
  validateBody: (req: { body?: unknown }, schema: { safeParse: (d: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }) => {
    const r = schema.safeParse(req.body);
    if (r.success) return { ok: true, value: r.data };
    const first = r.error?.issues[0];
    return { ok: false, error: first ? `${first.path.join('.')}: ${first.message}` : 'Validation failed' };
  },
  // Revocation check used by the /token mint path (auth-resolver). Default:
  // not revoked, so existing resolveIdentity suites are unaffected; a suite
  // exercising revocation overrides this via apiCoreMock({ isAccessTokenRevoked }).
  isAccessTokenRevoked: async () => false,
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...imageRegistryDefaults(), ...overrides });
}
