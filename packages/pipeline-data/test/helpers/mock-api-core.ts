// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pipeline-data's `@pipeline-builder/api-core` mock.
 *
 * The shared parts (REAL api-core base, logger stub, `ErrorCode` proxy, error
 * classes, pagination constants) live in
 * `@pipeline-builder/api-core/testing`. Only
 * pipeline-data-specific defaults belong here.
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

/**
 * Records every cache key the mocked `createCacheService().getOrSet` is asked
 * for, in call order. Suites that assert cache-key construction (e.g. the DORA
 * window must be part of the key so overrides don't collide) read + reset this.
 * Harmless to suites that ignore it.
 */
export const cacheKeyLog: string[] = [];

/**
 * Real AWS-scrub behavior (small, pure) so suites that persist AWS-derived event
 * data assert the actual redaction, not a stub. Mirrors
 * api-core/src/utils/aws-scrub.ts.
 */
function scrubAwsIdentifiers<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/(?<!\d)\d{12}(?!\d)/g, '[REDACTED]') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubAwsIdentifiers(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /account/i.test(k) && (typeof v === 'string' || typeof v === 'number')
        ? '[REDACTED]'
        : scrubAwsIdentifiers(v);
    }
    return out as T;
  }
  return value;
}

/** pipeline-data-specific defaults layered over the shared base. */
const pipelineDataDefaults = (): Record<string, unknown> => ({
  VISIBILITIES: ['private', 'org', 'public'],
  scrubAwsIdentifiersFromString: (input: string): string =>
    input.replace(/(?<!\d)\d{12}(?!\d)/g, '[REDACTED]'),
  scrubAwsIdentifiers,
  createCacheService: () => ({
    getOrSet: (key: string, factory: () => Promise<unknown>) => { cacheKeyLog.push(key); return factory(); },
    invalidatePattern: () => Promise.resolve(0),
  }),
});

/**
 * Default api-core namespace for `unstable_mockModule`. Spread `overrides` last
 * so a suite can replace any default (and add exports the default omits).
 */
export function apiCoreMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseApiCoreMock(actualApiCore, { ...pipelineDataDefaults(), ...overrides });
}
