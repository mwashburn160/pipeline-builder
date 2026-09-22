// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockSend = jest.fn<AnyFn>();
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((params: unknown) => params),
}));

const { createPlatformCredential, assertAccessKey, isCredentialRefusal } = await import('../src/handlers/platform-credential.js');

const KEY = 'pb_sa_1111111111111111111111111111aaaa';

describe('platform credential', () => {
  beforeEach(() => { mockSend.mockReset(); delete process.env.TEST_KEY; });

  it('reads the secret lazily, caches, and re-reads after invalidate', async () => {
    let name: string | undefined;
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: KEY }) });
    const cred = createPlatformCredential({ secretName: () => name });
    await expect(cred.getKey()).rejects.toThrow(/PLATFORM_SECRET_NAME/);
    name = 's';
    expect(await cred.getKey()).toBe(KEY);
    await cred.getKey();
    expect(mockSend).toHaveBeenCalledTimes(1);
    cred.invalidate();
    await cred.getKey();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('prefers an env key, keeps it across invalidate, and forgets it on reset', async () => {
    process.env.TEST_KEY = KEY;
    const cred = createPlatformCredential({ secretName: 's', envKeyVar: 'TEST_KEY' });
    expect(await cred.getKey()).toBe(KEY);
    delete process.env.TEST_KEY;
    cred.invalidate();
    expect(await cred.getKey()).toBe(KEY);
    cred.reset();
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: KEY }) });
    expect(await cred.getKey()).toBe(KEY);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('names the missing configuration when no secret name resolves', async () => {
    await expect(createPlatformCredential({ secretName: () => '' }).getKey()).rejects.toThrow(/^PLATFORM_SECRET_NAME environment variable is required$/);
    await expect(createPlatformCredential({ secretName: '', envKeyVar: 'UNSET_TEST_KEY' }).getKey())
      .rejects.toThrow(/^UNSET_TEST_KEY or PLATFORM_SECRET_NAME/);
  });

  it('refuses a missing, empty or non-key secret value', async () => {
    const cred = createPlatformCredential({ secretName: 's' });
    mockSend.mockResolvedValueOnce({});
    await expect(cred.getKey()).rejects.toThrow(/is empty/);
    mockSend.mockResolvedValueOnce({ SecretString: '{}' });
    await expect(cred.getKey()).rejects.toThrow(/missing password/);
    expect(() => assertAccessKey('opaque', 'x')).toThrow(/expected a "pb_sa_…" value\)\.$/);
    expect(isCredentialRefusal(401) && isCredentialRefusal(403) && !isCredentialRefusal(500)).toBe(true);
  });
});
