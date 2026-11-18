// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ask's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants) live in
 * `@pipeline-builder/api-core/testing`. Only ask-specific
 * defaults belong here.
 *
 * Ask was the last service still hand-rolling this mock inline in three suites —
 * the `no-restricted-syntax` rule in `.projenrc.ts` now stops that (see
 * docs/testing.md for why a whole-namespace literal goes stale).
 */
import { jest } from '@jest/globals';
import { baseApiCoreMock, loggerMock, passThroughMiddleware } from '@pipeline-builder/api-core/testing';

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/** Ask-specific defaults layered over the shared base. */
const askDefaults = (): Record<string, unknown> => ({
  // Route-table gate declarations on the ask routes. The real gate behaviour is
  // covered by api-core's own gate-denial suite + the route-coverage test, so a
  // pass-through is right here: these suites exercise handler logic.
  requirePermission: () => passThroughMiddleware,
  requirePermissionOrService: () => passThroughMiddleware,
  requireFeature: () => passThroughMiddleware,
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...askDefaults(), ...overrides });
}
