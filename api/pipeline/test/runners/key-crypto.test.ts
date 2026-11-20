// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The signing keys' secret encryption telling a transient key-service failure
 * (the per-org KMS config lookup, or KMS unreachable / throttled / 5xx) from a
 * real decrypt failure of the stored ciphertext: only the latter may become
 * RUNNER_KEY_UNREADABLE.
 */

import { describe, expect, it } from '@jest/globals';
import { EnvKeyProvider, getDefaultKeyProvider, PerOrgKmsKeyProvider, resetDefaultKeyProvider, type KeyProvider } from '@pipeline-builder/api-core';
import { isRunnerKeyServiceUnavailable } from '@pipeline-builder/api-core/pipeline-runners';
import { cachedKmsResolver, initRunnerKeyEncryption, isTransientKmsError, keySecrets } from '../../src/runners/key-crypto.js';

const ORG = '0123456789abcdef01234567';
const MASTER = 'a'.repeat(64);

/** A provider whose key derivation (the KMS Decrypt of the org's wrapped master) throws `err`. */
const failingProvider = (err: unknown): KeyProvider => ({
  deriveKey: () => { throw err; },
  deriveKeyAsync: async () => { throw err; },
});
const awsError = (name: string, httpStatusCode: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode }, ...extra });

describe('cachedKmsResolver', () => {
  it('a failed lookup is a transient key-service error (not cached); a later success is', async () => {
    let fail = true;
    let calls = 0;
    const { resolver } = cachedKmsResolver(async () => { calls++; if (fail) throw new Error('KMS config lookup failed (HTTP 503)'); return null; });
    const err = await resolver(ORG).catch((e: unknown) => e);
    expect(isRunnerKeyServiceUnavailable(err)).toBe(true);
    expect(err).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', source: 'kms_config' });
    fail = false;
    await expect(resolver(ORG)).resolves.toBeNull();
    await expect(resolver(ORG)).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it('through the per-org KMS provider, a lookup failure on decrypt is still the transient error', async () => {
    const env = new EnvKeyProvider(MASTER);
    const stored = await keySecrets(() => env).encrypt('pem', ORG);
    const { resolver } = cachedKmsResolver(async () => { throw new Error('platform down'); });
    const perOrg = new PerOrgKmsKeyProvider({ resolver, fallback: env });
    const err = await keySecrets(() => perOrg).decrypt(stored, ORG).catch((e: unknown) => e);
    expect(isRunnerKeyServiceUnavailable(err)).toBe(true);
  });
});

describe('initRunnerKeyEncryption (per-org KMS)', () => {
  it('an eviction reaching the provider (e.g. broadcast from platform) also drops the resolver\'s 60 s config cache', async () => {
    const saved = process.env.SECRET_ENCRYPTION_KEY;
    process.env.SECRET_ENCRYPTION_KEY = MASTER;
    try {
      resetDefaultKeyProvider();
      let calls = 0;
      await initRunnerKeyEncryption({ SECRET_ENCRYPTION_PER_ORG_KMS: 'true' }, async () => { calls++; return null; });
      const provider = getDefaultKeyProvider() as PerOrgKmsKeyProvider;
      expect(provider).toBeInstanceOf(PerOrgKmsKeyProvider);
      await provider.ensureWarmed(ORG);
      expect(calls).toBe(1);
      // Without the hook the resolver would answer from its own cache and the
      // eviction would re-install the OLD config for another TTL.
      provider.evict(ORG);
      await provider.ensureWarmed(ORG);
      expect(calls).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.SECRET_ENCRYPTION_KEY; else process.env.SECRET_ENCRYPTION_KEY = saved;
      resetDefaultKeyProvider();
    }
  });
});

describe('keySecrets', () => {
  it.each([
    ['throttled', awsError('ThrottlingException', 400)],
    ['KMS 5xx', awsError('KMSInternalException', 500)],
    ['a dependency timeout', awsError('DependencyTimeoutException', 503)],
    ['retryable per the SDK', awsError('SomethingNew', 400, { $retryable: {} })],
    ['a network error', Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })],
    ['an SDK timeout', Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })],
  ])('KMS %s on decrypt or encrypt is the transient key-service error', async (_label, cause) => {
    const secrets = keySecrets(() => failingProvider(cause));
    const stored = await keySecrets(() => new EnvKeyProvider(MASTER)).encrypt('pem', ORG);
    for (const op of [() => secrets.decrypt(stored, ORG), () => secrets.encrypt('pem', ORG)]) {
      const err = await op().catch((e: unknown) => e);
      expect(isRunnerKeyServiceUnavailable(err)).toBe(true);
      expect(err).toMatchObject({ source: 'kms' });
    }
  });

  it.each([
    ['a KMS key that refuses the ciphertext', awsError('InvalidCiphertextException', 400)],
    ['access denied', awsError('AccessDeniedException', 400)],
    ['a disabled key', awsError('DisabledException', 400)],
  ])('%s is NOT transient (the key cannot be read: RUNNER_KEY_UNREADABLE upstream)', async (_label, cause) => {
    const stored = await keySecrets(() => new EnvKeyProvider(MASTER)).encrypt('pem', ORG);
    const err = await keySecrets(() => failingProvider(cause)).decrypt(stored, ORG).catch((e: unknown) => e);
    expect(isRunnerKeyServiceUnavailable(err)).toBe(false);
    expect(err).toBe(cause);
  });

  it('a wrong master or a tampered blob is a real decrypt failure, not transient', async () => {
    const stored = await keySecrets(() => new EnvKeyProvider(MASTER)).encrypt('pem', ORG);
    const wrong = await keySecrets(() => new EnvKeyProvider('b'.repeat(64))).decrypt(stored, ORG).catch((e: unknown) => e);
    expect(isRunnerKeyServiceUnavailable(wrong)).toBe(false);
    const junk = await keySecrets(() => new EnvKeyProvider(MASTER)).decrypt('not json', ORG).catch((e: unknown) => e);
    expect(isRunnerKeyServiceUnavailable(junk)).toBe(false);
  });

  it('isTransientKmsError: only transport, throttling and server-side KMS failures', () => {
    expect(isTransientKmsError(awsError('ThrottlingException', 400))).toBe(true);
    expect(isTransientKmsError(awsError('InvalidCiphertextException', 400))).toBe(false);
    expect(isTransientKmsError(new Error('Unsupported state or unable to authenticate data'))).toBe(false);
    expect(isTransientKmsError(null)).toBe(false);
  });
});
