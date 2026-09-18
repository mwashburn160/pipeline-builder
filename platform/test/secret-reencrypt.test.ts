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
const mockOrgFind = jest.fn<(...a: unknown[]) => unknown>();
const mockIdpFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockIdpFind = jest.fn<(...a: unknown[]) => unknown>();
const mockIdpUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockWrap = jest.fn<(...a: unknown[]) => string>();
const mockUnwrap = jest.fn<(...a: unknown[]) => string>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {
    findById: (...a: unknown[]) => mockOrgFindById(...a),
    find: (...a: unknown[]) => mockOrgFind(...a),
  },
}));

jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => mockIdpFindOne(...a),
    find: (...a: unknown[]) => mockIdpFind(...a),
    updateOne: (...a: unknown[]) => mockIdpUpdateOne(...a),
  },
}));

jest.unstable_mockModule('../src/utils/secret-blob.js', () => ({
  wrapEncrypted: (...a: unknown[]) => mockWrap(...a),
  unwrapEncrypted: (...a: unknown[]) => mockUnwrap(...a),
}));

const { reencryptOrgSecrets, captureOrgSecrets, reencryptAllStoredSecrets } = await import('../src/services/secret-reencrypt.js');

/** `Model.find().select().cursor()` over a fixed array of docs. */
function cursorOver(docs: unknown[]) {
  return { select: () => ({ cursor: () => (async function* () { yield* docs; })() }) };
}

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

describe('reencryptAllStoredSecrets (SECRET_ENCRYPTION_KEY rotation)', () => {
  it('re-wraps every org AI key and every IdP secret, reporting counts', async () => {
    const orgA: any = { _id: 'org-a', aiProviderKeys: { anthropic: 'old-a', openai: 'old-o' }, markModified: jest.fn(), save: jest.fn(async () => undefined) };
    const orgB: any = { _id: 'org-b', aiProviderKeys: undefined, markModified: jest.fn(), save: jest.fn(async () => undefined) };
    mockOrgFind.mockReturnValue(cursorOver([orgA, orgB]));
    mockIdpFind.mockReturnValue(cursorOver([{ _id: 'idp-1', orgId: 'org-a', clientSecretEncrypted: 'old-idp' }]));
    mockUnwrap.mockImplementation((raw: unknown) => `plain:${raw}`);

    const summary = await reencryptAllStoredSecrets();

    expect(summary).toEqual({ orgsScanned: 2, aiKeysReencrypted: 2, idpSecretsReencrypted: 1, failures: [] });
    // Each blob was read (previous key falls back inside decryptSecret) and
    // written back under the now-current key.
    expect(orgA.aiProviderKeys.anthropic).toBe('enc:plain:old-a');
    expect(orgA.aiProviderKeys.openai).toBe('enc:plain:old-o');
    expect(orgA.save).toHaveBeenCalledTimes(1);
    // An org with no keys is scanned but never written.
    expect(orgB.save).not.toHaveBeenCalled();
    expect(mockIdpUpdateOne).toHaveBeenCalledWith({ _id: 'idp-1' }, { $set: { clientSecretEncrypted: 'enc:plain:old-idp' } });
  });

  it('records an unreadable row as a failure and keeps going (caller exits non-zero)', async () => {
    const orgA: any = { _id: 'org-a', aiProviderKeys: { anthropic: 'broken', openai: 'old-o' }, markModified: jest.fn(), save: jest.fn(async () => undefined) };
    mockOrgFind.mockReturnValue(cursorOver([orgA]));
    mockIdpFind.mockReturnValue(cursorOver([]));
    mockUnwrap.mockImplementation((raw: unknown) => {
      if (raw === 'broken') throw new Error('bad auth tag');
      return `plain:${raw}`;
    });

    const summary = await reencryptAllStoredSecrets();

    expect(summary.aiKeysReencrypted).toBe(1);
    expect(summary.failures).toEqual([{ orgId: 'org-a', field: 'aiProviderKeys.anthropic', error: 'bad auth tag' }]);
    // The readable key was still migrated, and the unreadable blob is untouched.
    expect(orgA.aiProviderKeys.openai).toBe('enc:plain:old-o');
    expect(orgA.aiProviderKeys.anthropic).toBe('broken');
  });
});
