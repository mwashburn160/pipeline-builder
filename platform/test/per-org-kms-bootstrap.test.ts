// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SECRET_ENCRYPTION_PER_ORG_KMS=true wiring at platform
 * startup, plus the Mongo-backed resolver that maps orgId → KMS config.
 */

const mockSetKeyProvider = jest.fn();
const mockEnvKeyProvider = jest.fn();
const mockPerOrgCtor = jest.fn();
const mockOrgFindById = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  EnvKeyProvider: jest.fn().mockImplementation(() => {
    mockEnvKeyProvider();
    return { __type: 'EnvKeyProvider' };
  }),
  PerOrgKmsKeyProvider: jest.fn().mockImplementation((opts: unknown) => {
    mockPerOrgCtor(opts);
    return { __type: 'PerOrgKmsKeyProvider', opts };
  }),
  setKeyProvider: (provider: unknown) => mockSetKeyProvider(provider),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../src/models', () => ({
  Organization: {
    findById: (...args: unknown[]) => mockOrgFindById(...args),
  },
}));

import { bootstrapPerOrgKmsProvider, perOrgKmsResolver } from '../src/services/per-org-kms-bootstrap';

const ORIGINAL_FLAG = process.env.SECRET_ENCRYPTION_PER_ORG_KMS;

beforeEach(() => {
  mockSetKeyProvider.mockReset();
  mockEnvKeyProvider.mockReset();
  mockPerOrgCtor.mockReset();
  mockOrgFindById.mockReset();
  delete process.env.SECRET_ENCRYPTION_PER_ORG_KMS;
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.SECRET_ENCRYPTION_PER_ORG_KMS;
  else process.env.SECRET_ENCRYPTION_PER_ORG_KMS = ORIGINAL_FLAG;
});

describe('bootstrapPerOrgKmsProvider', () => {
  it('is a no-op (returns false) when the flag is unset', () => {
    expect(bootstrapPerOrgKmsProvider()).toBe(false);
    expect(mockSetKeyProvider).not.toHaveBeenCalled();
    expect(mockPerOrgCtor).not.toHaveBeenCalled();
  });

  it('is a no-op when the flag is anything other than literal "true"', () => {
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = '1';
    expect(bootstrapPerOrgKmsProvider()).toBe(false);
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = 'yes';
    expect(bootstrapPerOrgKmsProvider()).toBe(false);
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = '';
    expect(bootstrapPerOrgKmsProvider()).toBe(false);
    expect(mockSetKeyProvider).not.toHaveBeenCalled();
  });

  it('installs PerOrgKmsKeyProvider when the flag is "true" (case-insensitive)', () => {
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = 'TRUE';
    expect(bootstrapPerOrgKmsProvider()).toBe(true);
    expect(mockEnvKeyProvider).toHaveBeenCalledTimes(1);
    expect(mockPerOrgCtor).toHaveBeenCalledTimes(1);
    expect(mockSetKeyProvider).toHaveBeenCalledTimes(1);
    // Provider passed to setKeyProvider must be the PerOrgKmsKeyProvider stub.
    expect(mockSetKeyProvider.mock.calls[0][0]).toMatchObject({ __type: 'PerOrgKmsKeyProvider' });
    // Constructor receives a resolver + fallback. Fallback must be the env provider.
    const ctorArg = mockPerOrgCtor.mock.calls[0][0] as { resolver: unknown; fallback: unknown };
    expect(typeof ctorArg.resolver).toBe('function');
    expect(ctorArg.fallback).toMatchObject({ __type: 'EnvKeyProvider' });
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
