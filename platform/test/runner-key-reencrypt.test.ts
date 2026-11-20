// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `reencryptRunnerSigningKeys` — platform's call to
 * PIPELINE_INTERNAL.reencryptRunnerSigningKeys. Every failure (unreachable,
 * non-2xx, a bad reply, rows left unreadable) comes back as `ok: false` with a
 * reason; nothing is swallowed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPost = jest.fn<AnyFn>();
const mockClientOpts = jest.fn<AnyFn>();
const mockAuth = jest.fn<AnyFn>(() => 'Bearer svc');

jest.unstable_mockModule('@pipeline-builder/api-core', async () => {
  const real = await import('@pipeline-builder/api-core/lib/contracts/call.js');
  const { PIPELINE_INTERNAL } = await import('@pipeline-builder/api-core/lib/contracts/pipeline.js');
  return apiCoreMock({
    PIPELINE_INTERNAL,
    callInternal: real.callInternal,
    SYSTEM_ORG_ID: 'system',
    createSafeClient: (opts: unknown) => { mockClientOpts(opts); return { post: mockPost }; },
    getServiceAuthHeader: (...a: unknown[]) => mockAuth(...a),
  });
});
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ pipeline: { serviceHost: 'pipeline', servicePort: 3000 } }));

const { reencryptRunnerSigningKeys } = await import('../src/services/runner-key-reencrypt.js');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const reply = (statusCode: number, data: unknown) => ({ statusCode, headers: {}, body: { success: statusCode < 300, data } });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reencryptRunnerSigningKeys', () => {
  it('a SECRET_ENCRYPTION_KEY rotation sends an empty body (every org) with a system-org platform token', async () => {
    mockPost.mockResolvedValue(reply(200, { scanned: 3, reencrypted: 3, failures: [] }));
    const result = await reencryptRunnerSigningKeys();
    expect(result).toEqual({ ok: true, counts: { scanned: 3, reencrypted: 3, failures: [] } });
    expect(mockPost).toHaveBeenCalledWith('/pipelines/internal/runner-signing-keys/reencrypt', {}, expect.anything());
    expect(mockAuth).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'platform', orgId: 'system' }));
    expect(mockClientOpts).toHaveBeenCalledWith(expect.objectContaining({ host: 'pipeline', port: 3000 }));
  });

  it('a per-org KMS rotation names the org and the previous config', async () => {
    mockPost.mockResolvedValue(reply(200, { scanned: 1, reencrypted: 1, failures: [] }));
    const previousKmsConfig = { keyId: 'alias/old', ciphertextBase64: 'T0xE' };
    await reencryptRunnerSigningKeys({ orgId: ORG, previousKmsConfig });
    expect(mockPost.mock.calls[0][1]).toEqual({ orgId: ORG, previousKmsConfig });
    await reencryptRunnerSigningKeys({ orgId: ORG });
    expect(mockPost.mock.calls[1][1]).toEqual({ orgId: ORG, previousKmsConfig: null });
  });

  it('reports rows left unreadable as a failure, with the counts', async () => {
    const failures = [{ orgId: ORG, kid: 'kid-1', error: 'decrypt failed' }];
    mockPost.mockResolvedValue(reply(200, { scanned: 2, reencrypted: 1, failures }));
    const result = await reencryptRunnerSigningKeys();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(new RegExp(`${ORG}/kid-1`));
    expect(result.counts?.failures).toEqual(failures);
  });

  it('reports an unreachable pipeline, a non-2xx and an unreadable reply', async () => {
    mockPost.mockResolvedValueOnce(null);
    expect(await reencryptRunnerSigningKeys()).toEqual({ ok: false, error: expect.stringMatching(/unreachable/) });
    mockPost.mockResolvedValueOnce(reply(500, undefined));
    expect(await reencryptRunnerSigningKeys()).toEqual({ ok: false, error: expect.stringMatching(/HTTP 500/) });
    mockPost.mockResolvedValueOnce(reply(200, { nope: true }));
    expect(await reencryptRunnerSigningKeys()).toEqual({ ok: false, error: expect.stringMatching(/unreadable pipeline response/) });
    mockPost.mockRejectedValueOnce(new Error('boom'));
    expect(await reencryptRunnerSigningKeys()).toEqual({ ok: false, error: expect.stringMatching(/boom/) });
  });
});
