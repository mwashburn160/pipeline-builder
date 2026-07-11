// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/secret-reencrypt.ts — the KMS-rotation migration helper.
 *
 * `test-org-kms-config.test.ts` mocks this module away; here we run it for
 * real (with the crypto primitive + model layer stubbed) to prove:
 *   - reencryptOrgSecrets re-wraps every captured AI key + the IdP secret
 *     under the now-active provider and persists them.
 *   - an encrypt failure THROWS (surfaces loud) rather than silently dropping
 *     a secret — the caller reverts / alerts on-call.
 *   - captureOrgSecrets refuses (throws) when an existing blob can't be
 *     decrypted, so a rotation never proceeds over unreadable data.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockIdpFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockIdpUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockWrap = jest.fn<(...a: unknown[]) => string>();
const mockUnwrap = jest.fn<(...a: unknown[]) => string>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));

jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => mockIdpFindOne(...a),
    updateOne: (...a: unknown[]) => mockIdpUpdateOne(...a),
  },
}));

jest.unstable_mockModule('../src/utils/secret-blob.js', () => ({
  wrapEncrypted: (...a: unknown[]) => mockWrap(...a),
  unwrapEncrypted: (...a: unknown[]) => mockUnwrap(...a),
}));

const { reencryptOrgSecrets, captureOrgSecrets } = await import('../src/services/secret-reencrypt.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockIdpUpdateOne.mockResolvedValue(undefined);
  mockWrap.mockImplementation((pt: unknown) => `enc:${pt}`);
});

describe('reencryptOrgSecrets', () => {
  it('re-wraps every captured AI key + the IdP secret and persists them', async () => {
    const orgDoc: any = { aiProviderKeys: {}, markModified: jest.fn(), save: jest.fn(async () => undefined) };
    mockOrgFindById.mockResolvedValue(orgDoc);

    const counts = await reencryptOrgSecrets('org-1', {
      aiKeys: { anthropic: 'k-anthropic', openai: 'k-openai' },
      idpClientSecret: 'idp-plain',
    });

    expect(counts).toEqual({ aiKeysReencrypted: 2, idpSecretReencrypted: true });
    // AI keys re-wrapped under the (new) active provider and saved.
    expect(orgDoc.aiProviderKeys.anthropic).toBe('enc:k-anthropic');
    expect(orgDoc.aiProviderKeys.openai).toBe('enc:k-openai');
    expect(orgDoc.markModified).toHaveBeenCalledWith('aiProviderKeys');
    expect(orgDoc.save).toHaveBeenCalledTimes(1);
    // IdP secret re-wrapped via a targeted update.
    expect(mockIdpUpdateOne).toHaveBeenCalledWith(
      { orgId: 'org-1' },
      { $set: { clientSecretEncrypted: 'enc:idp-plain' } },
    );
  });

  it('leaves the IdP row alone when no IdP secret was captured', async () => {
    const orgDoc: any = { aiProviderKeys: {}, markModified: jest.fn(), save: jest.fn(async () => undefined) };
    mockOrgFindById.mockResolvedValue(orgDoc);

    const counts = await reencryptOrgSecrets('org-1', { aiKeys: { openai: 'k' } });

    expect(counts).toEqual({ aiKeysReencrypted: 1, idpSecretReencrypted: false });
    expect(mockIdpUpdateOne).not.toHaveBeenCalled();
  });

  it('THROWS (does not silently drop) when re-encrypting a secret fails', async () => {
    const orgDoc: any = { aiProviderKeys: {}, markModified: jest.fn(), save: jest.fn(async () => undefined) };
    mockOrgFindById.mockResolvedValue(orgDoc);
    mockWrap.mockImplementation((pt: unknown) => {
      if (pt === 'k-openai') throw new Error('KMS Encrypt denied');
      return `enc:${pt}`;
    });

    await expect(
      reencryptOrgSecrets('org-1', { aiKeys: { openai: 'k-openai' }, idpClientSecret: 'idp-plain' }),
    ).rejects.toThrow('KMS Encrypt denied');
    // The failure short-circuits BEFORE the IdP row is touched — no partial,
    // silently-lost secret.
    expect(mockIdpUpdateOne).not.toHaveBeenCalled();
  });
});

describe('captureOrgSecrets', () => {
  it('throws when an existing AI key blob cannot be decrypted (rotation must not proceed)', async () => {
    mockOrgFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ aiProviderKeys: { anthropic: 'cipher' } }) }),
    });
    mockUnwrap.mockImplementation(() => { throw new Error('bad auth tag'); });

    await expect(captureOrgSecrets('org-1')).rejects.toThrow(/Failed to decrypt aiProviderKeys.anthropic/);
    // Never advanced to the IdP read — capture aborts on the first failure.
    expect(mockIdpFindOne).not.toHaveBeenCalled();
  });

  it('captures decrypted plaintexts for AI keys + IdP secret on the happy path', async () => {
    mockOrgFindById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ aiProviderKeys: { openai: 'cipher-openai' } }) }),
    });
    mockIdpFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ clientSecretEncrypted: 'cipher-idp' }) }),
    });
    mockUnwrap.mockImplementation((raw: unknown) => `plain:${raw}`);

    const captured = await captureOrgSecrets('org-1');
    expect(captured.aiKeys.openai).toBe('plain:cipher-openai');
    expect(captured.idpClientSecret).toBe('plain:cipher-idp');
  });
});
