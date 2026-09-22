// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pipeline-core's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants) live in
 * `@pipeline-builder/api-core/testing`. Only
 * pipeline-core-specific defaults belong here.
 */
import { jest } from '@jest/globals';
import { baseApiCoreMock, loggerMock } from '@pipeline-builder/api-core/testing';

export { loggerMock };

/**
 * The REAL api-core exports, resolved HERE (not inside the shared factory):
 * `requireActual` on an ESM barrel only succeeds while nothing else is
 * mid-`import()` of it, and this module — a static import of every suite that
 * uses it, evaluated before the suite's `await import(SUT)` — is the one point
 * where that reliably holds.
 */
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

/** pipeline-core-specific defaults layered over the shared base. */
const pipelineCoreDefaults = (): Record<string, unknown> => ({
  // Optional-dep require shim → always "unavailable" so callers fall back to no-ops.
  safeCreateRequire: () => ((_id: string) => { throw new Error('require unavailable in tests'); }),
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...pipelineCoreDefaults(), ...overrides });
}
