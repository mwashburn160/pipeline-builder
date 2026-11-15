// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `classifyFailure` decides whether a failed build is worth retrying. A build
 * whose context has no Dockerfile will lack one on every attempt, so it must
 * come out permanent; a bare filesystem error stays retryable.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  db: undefined,
  schema: {},
  reportingService: {},
  runWithTenantContext: (_org: string, fn: () => unknown) => fn(),
  withTenantTx: async () => undefined,
}));

const { ValidationError } = await import('@pipeline-builder/api-core');
const { classifyFailure } = await import('../src/queue/build-failures.js');

describe('classifyFailure', () => {
  it('treats a missing Dockerfile in the build context as permanent', () => {
    expect(classifyFailure(new ValidationError('Dockerfile "Dockerfile" not found in the build context'))).toBe('permanent');
  });

  it('keeps a bare ENOENT retryable (e.g. a transient filesystem error)', () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory, open \'/tmp/x\''), { code: 'ENOENT' });
    expect(classifyFailure(enoent)).toBe('retryable');
  });
});
