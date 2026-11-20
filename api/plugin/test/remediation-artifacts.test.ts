// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The live remediation artifact reader behind the patch / export downloads: a
 * stored key whose object is gone is "not stored" (the routes answer 404), any
 * other storage error still fails.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

const send = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core/s3', () => stubModule('@pipeline-builder/api-core/s3', { s3Client: () => ({ send }), ensureBucket: jest.fn() }));
jest.unstable_mockModule('../src/services/plugin-sources.js', () => ({ pluginSourcesBucket: () => 'plugin-sources' }));

const { readRemediationArtifact } = await import('../src/services/remediation/artifacts.js');

describe('readRemediationArtifact', () => {
  it('returns the object text', async () => {
    send.mockResolvedValueOnce({ Body: { transformToString: async () => '--- a/x\n' } } as never);
    expect(await readRemediationArtifact('k')).toBe('--- a/x\n');
  });

  it('reads a missing object (NoSuchKey / NotFound) as not stored', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchKey' }) as never);
    expect(await readRemediationArtifact('k')).toBeNull();
    send.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotFound' }) as never);
    expect(await readRemediationArtifact('k')).toBeNull();
  });

  it('still fails on any other storage error', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }) as never);
    await expect(readRemediationArtifact('k')).rejects.toThrow('denied');
  });
});
