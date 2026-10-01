// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SECRET_ENCRYPTION_PER_ORG_KMS=true wiring at platform
 * startup, plus the Mongo-backed resolver that maps orgId → KMS config.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockSetKeyProvider = jest.fn();
const mockEnvKeyProvider = jest.fn();
const mockPerOrgCtor = jest.fn();
const mockOrgFindById = jest.fn();
/** What `initSecretEncryption` reports. Per test, so the bootstrap's handling of
 *  each base mode is exercised without standing up a real KMS client. */
const mockInitSecretEncryption = jest.fn<() => Promise<{ provider: unknown; mode: 'env' | 'kms' }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  EnvKeyProvider: jest.fn().mockImplementation(() => {
    mockEnvKeyProvider();
    return { __type: 'EnvKeyProvider' };
  }),
  PerOrgKmsKeyProvider: jest.fn().mockImplementation((opts: unknown) => {
    mockPerOrgCtor(opts);
    return { __type: 'PerOrgKmsKeyProvider', opts };
  }),
  setKeyProvider: (provider: unknown) => mockSetKeyProvider(provider),
  initSecretEncryption: () => mockInitSecretEncryption(),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {
    findById: (...args: unknown[]) => mockOrgFindById(...args),
  },
}));

const { bootstrapPerOrgKmsProvider, perOrgKmsResolver } = await import('../src/services/per-org-kms-bootstrap.js');


const ORIGINAL_FLAG = process.env.SECRET_ENCRYPTION_PER_ORG_KMS;

beforeEach(() => {
  mockSetKeyProvider.mockReset();
  mockEnvKeyProvider.mockReset();
  mockPerOrgCtor.mockReset();
  mockOrgFindById.mockReset();
  mockInitSecretEncryption.mockReset();
  // Default: no KMS configured, so the base stays the lazy env provider.
  mockInitSecretEncryption.mockResolvedValue({ provider: null, mode: 'env' });
  delete process.env.SECRET_ENCRYPTION_PER_ORG_KMS;
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.SECRET_ENCRYPTION_PER_ORG_KMS;
  else process.env.SECRET_ENCRYPTION_PER_ORG_KMS = ORIGINAL_FLAG;
});

describe('bootstrapPerOrgKmsProvider', () => {
  it('initializes the base provider even when the per-org flag is unset', async () => {
    // It must NOT return early. A configured KmsKeyProvider has to be warmed
    // before anything reads a secret — its deriveKey refuses to work cold — and
    // that warming is `initSecretEncryption`'s job regardless of this flag.
    await expect(bootstrapPerOrgKmsProvider()).resolves.toEqual({ mode: 'env', perOrg: false });
    expect(mockInitSecretEncryption).toHaveBeenCalledTimes(1);
    expect(mockSetKeyProvider).not.toHaveBeenCalled();
    expect(mockPerOrgCtor).not.toHaveBeenCalled();
  });

  it('leaves per-org off for the flag spellings envBool reads as false', async () => {
    for (const v of ['false', '0', 'no', '', 'maybe']) {
      process.env.SECRET_ENCRYPTION_PER_ORG_KMS = v;
      await expect(bootstrapPerOrgKmsProvider()).resolves.toMatchObject({ perOrg: false });
    }
    expect(mockPerOrgCtor).not.toHaveBeenCalled();
  });

  it.each(['1', 'yes', 'TRUE'])('installs the provider for the truthy spelling %p', async (v) => {
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = v;
    await expect(bootstrapPerOrgKmsProvider()).resolves.toMatchObject({ perOrg: true });
  });

  it('installs PerOrgKmsKeyProvider over an env base, with an env fallback', async () => {
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = 'TRUE';
    await bootstrapPerOrgKmsProvider();
    expect(mockEnvKeyProvider).toHaveBeenCalledTimes(1);
    expect(mockPerOrgCtor).toHaveBeenCalledTimes(1);
    expect(mockSetKeyProvider).toHaveBeenCalledTimes(1);
    expect(mockSetKeyProvider.mock.calls[0][0]).toMatchObject({ __type: 'PerOrgKmsKeyProvider' });
    const ctorArg = mockPerOrgCtor.mock.calls[0][0] as { resolver: unknown; fallback: unknown };
    expect(typeof ctorArg.resolver).toBe('function');
    expect(ctorArg.fallback).toMatchObject({ __type: 'EnvKeyProvider' });
  });

  it('passes a KMS base DOWN as the fallback instead of building an env provider', async () => {
    // THE REGRESSION THIS GUARDS. The fallback used to be a freshly constructed
    // `EnvKeyProvider`, unconditionally — so every org WITHOUT its own CMK was
    // pinned to the plaintext master even on a deployment that had configured a
    // KMS-wrapped one. Orgs with no per-org config must inherit the base mode.
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = 'true';
    const kmsBase = { __type: 'KmsKeyProvider' };
    mockInitSecretEncryption.mockResolvedValue({ provider: kmsBase, mode: 'kms' });

    await expect(bootstrapPerOrgKmsProvider()).resolves.toEqual({ mode: 'kms', perOrg: true });
    const ctorArg = mockPerOrgCtor.mock.calls[0][0] as { fallback: unknown };
    expect(ctorArg.fallback).toBe(kmsBase);
    expect(mockEnvKeyProvider).not.toHaveBeenCalled();
  });
});

describe('perOrgKmsResolver', () => {
  function mockFind(result: unknown) {
    mockOrgFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve(result) }),
    });
  }

  it('returns the config when an org has both keyId and ciphertextBase64', async () => {
    mockFind({ kmsConfig: { keyId: 'alias/org-a', ciphertextBase64: Buffer.from('opaque').toString('base64') } });
    const cfg = await perOrgKmsResolver('org-a');
    expect(cfg).toEqual({
      keyId: 'alias/org-a',
      ciphertextBase64: Buffer.from('opaque').toString('base64'),
    });
  });

  it('returns null when the org has no kmsConfig subdocument', async () => {
    mockFind({ kmsConfig: undefined });
    expect(await perOrgKmsResolver('org-x')).toBeNull();
  });

  it('returns null when keyId is missing (partial config is treated as no config)', async () => {
    mockFind({ kmsConfig: { ciphertextBase64: 'opaque' } });
    expect(await perOrgKmsResolver('org-x')).toBeNull();
  });

  it('returns null when ciphertextBase64 is missing', async () => {
    mockFind({ kmsConfig: { keyId: 'alias/org-x' } });
    expect(await perOrgKmsResolver('org-x')).toBeNull();
  });

  it('returns null when the org document does not exist', async () => {
    mockFind(null);
    expect(await perOrgKmsResolver('org-missing')).toBeNull();
  });
});
