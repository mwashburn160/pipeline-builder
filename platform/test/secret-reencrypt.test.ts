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
 *   - each write is conditional on the captured blob: a secret set or deleted
 *     concurrently is kept / not resurrected, and reported by field name.
 *   - captureOrgSecrets refuses (throws) when an existing blob can't be
 *     decrypted, so a rotation never proceeds over unreadable data.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockOrgFindById = jest.fn<AnyFn>();
const mockOrgFind = jest.fn<AnyFn>();
const mockOrgUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIdpFindOne = jest.fn<AnyFn>();
const mockIdpFind = jest.fn<AnyFn>();
const mockIdpUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockTotpFind = jest.fn<AnyFn>();
const mockTotpUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSamlFind = jest.fn<AnyFn>();
const mockSamlUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
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
    updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a),
  },
  UserTotp: {
    find: (...a: unknown[]) => mockTotpFind(...a),
    updateOne: (...a: unknown[]) => mockTotpUpdateOne(...a),
  },
}));

jest.unstable_mockModule('../src/models/saml-sp-key.js', () => ({
  __esModule: true,
  default: {
    find: (...a: unknown[]) => mockSamlFind(...a),
    updateOne: (...a: unknown[]) => mockSamlUpdateOne(...a),
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

const { reencryptOrgSecrets, captureOrgSecrets, reencryptAllStoredSecrets, OrgSecretsReencryptError } = await import('../src/services/secret-reencrypt.js');

/** `Model.find().select().cursor()` over a fixed array of docs. */
function cursorOver(docs: unknown[]) {
  return { select: () => ({ cursor: () => (async function* () { yield* docs; })() }) };
}

/** `Model.find().cursor()` — the SP-key sweep needs no projection. */
function bareCursorOver(docs: unknown[]) {
  return { cursor: () => (async function* () { yield* docs; })() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIdpUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockOrgUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockWrap.mockImplementation((pt: unknown) => `enc:${pt}`);
});

/** `Model.findX().select().lean()` resolving to `doc` — the re-read after a conflict. */
function leanDoc(doc: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}

/** A captured set: plaintexts plus the exact stored blobs they were read from. */
const CAPTURED = {
  aiKeys: { anthropic: 'k-anthropic', openai: 'k-openai' },
  idpClientSecret: 'idp-plain',
  blobs: { aiKeys: { anthropic: 'old:anthropic', openai: 'old:openai' }, idpClientSecret: 'old:idp' },
};

describe('reencryptOrgSecrets', () => {
  it('re-wraps every captured AI key + the IdP secret, each write conditional on the blob it was captured from', async () => {
    const counts = await reencryptOrgSecrets('org-1', CAPTURED);

    expect(counts).toEqual({ aiKeysReencrypted: 2, idpSecretReencrypted: true, concurrentlyChanged: [], unreadableConcurrentWrites: [] });
    expect(mockOrgUpdateOne).toHaveBeenCalledWith(
      { '_id': 'org-1', 'aiProviderKeys.anthropic': 'old:anthropic' },
      { $set: { 'aiProviderKeys.anthropic': 'enc:k-anthropic' } },
    );
    expect(mockOrgUpdateOne).toHaveBeenCalledWith(
      { '_id': 'org-1', 'aiProviderKeys.openai': 'old:openai' },
      { $set: { 'aiProviderKeys.openai': 'enc:k-openai' } },
    );
    expect(mockIdpUpdateOne).toHaveBeenCalledWith(
      { organizationId: 'org-1', clientSecretEncrypted: 'old:idp' },
      { $set: { clientSecretEncrypted: 'enc:idp-plain' } },
    );
  });

  it('leaves the IdP row alone when no IdP secret was captured', async () => {
    const counts = await reencryptOrgSecrets('org-1', { aiKeys: { openai: 'k' }, blobs: { aiKeys: { openai: 'old:openai' } } });

    expect(counts).toMatchObject({ aiKeysReencrypted: 1, idpSecretReencrypted: false });
    expect(mockIdpUpdateOne).not.toHaveBeenCalled();
  });

  it('keeps an AI key set concurrently (under the new key) instead of overwriting it', async () => {
    // The openai filter no longer matches: someone set a new key in between.
    mockOrgUpdateOne.mockImplementation(async (filter: any) => ({ matchedCount: 'aiProviderKeys.openai' in filter ? 0 : 1 }));
    mockOrgFindById.mockReturnValue(leanDoc({ aiProviderKeys: { anthropic: 'enc:k-anthropic', openai: 'enc:fresh-openai' } }));
    mockUnwrap.mockImplementation((raw: unknown) => `plain:${raw}`);

    const counts = await reencryptOrgSecrets('org-1', CAPTURED);

    expect(counts).toEqual({
      aiKeysReencrypted: 1,
      idpSecretReencrypted: true,
      concurrentlyChanged: ['aiProviderKeys.openai'],
      unreadableConcurrentWrites: [],
    });
    // Only conditional writes: nothing can overwrite the fresh value.
    for (const [filter] of mockOrgUpdateOne.mock.calls) expect(Object.keys(filter as object)).toHaveLength(2);
    // The concurrent value was checked against the now-active key.
    expect(mockUnwrap).toHaveBeenCalledWith('enc:fresh-openai', 'org-1', 'aiProviderKeys.openai');
  });

  it('does not resurrect an AI key deleted concurrently', async () => {
    mockOrgUpdateOne.mockImplementation(async (filter: any) => ({ matchedCount: 'aiProviderKeys.openai' in filter ? 0 : 1 }));
    mockOrgFindById.mockReturnValue(leanDoc({ aiProviderKeys: { anthropic: 'enc:k-anthropic' } }));

    const counts = await reencryptOrgSecrets('org-1', CAPTURED);

    expect(counts).toMatchObject({ aiKeysReencrypted: 1, concurrentlyChanged: ['aiProviderKeys.openai'], unreadableConcurrentWrites: [] });
    // No unconditional write ever put the captured value back.
    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockUnwrap).not.toHaveBeenCalled();
  });

  it('reports a concurrent write still under the OLD key (a replica with a stale cache) as unreadable', async () => {
    mockOrgUpdateOne.mockImplementation(async (filter: any) => ({ matchedCount: 'aiProviderKeys.openai' in filter ? 0 : 1 }));
    mockOrgFindById.mockReturnValue(leanDoc({ aiProviderKeys: { openai: 'stale:openai' } }));
    mockUnwrap.mockImplementation(() => { throw new Error('KMS key id mismatch'); });

    const counts = await reencryptOrgSecrets('org-1', CAPTURED);

    expect(counts).toMatchObject({ concurrentlyChanged: ['aiProviderKeys.openai'], unreadableConcurrentWrites: ['aiProviderKeys.openai'] });
    // Never surfaces the secret value itself.
    expect(JSON.stringify(counts)).not.toContain('stale:openai');
  });

  it('keeps an IdP secret set concurrently instead of overwriting it', async () => {
    mockIdpUpdateOne.mockResolvedValue({ matchedCount: 0 });
    mockIdpFindOne.mockReturnValue(leanDoc({ clientSecretEncrypted: 'enc:fresh-idp' }));
    mockUnwrap.mockImplementation((raw: unknown) => `plain:${raw}`);

    const counts = await reencryptOrgSecrets('org-1', CAPTURED);

    expect(counts).toEqual({ aiKeysReencrypted: 2, idpSecretReencrypted: false, concurrentlyChanged: ['idpClientSecret'], unreadableConcurrentWrites: [] });
    expect(mockIdpUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockIdpUpdateOne.mock.calls[0][0]).toEqual({ organizationId: 'org-1', clientSecretEncrypted: 'old:idp' });
  });

  it('does not resurrect an IdP secret removed concurrently', async () => {
    mockIdpUpdateOne.mockResolvedValue({ matchedCount: 0 });
    mockIdpFindOne.mockReturnValue(leanDoc(null));

    const counts = await reencryptOrgSecrets('org-1', CAPTURED);

    expect(counts).toMatchObject({ idpSecretReencrypted: false, concurrentlyChanged: ['idpClientSecret'], unreadableConcurrentWrites: [] });
    expect(mockIdpUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('THROWS (does not silently drop) when re-encrypting a secret fails', async () => {
    mockWrap.mockImplementation((pt: unknown) => {
      if (pt === 'k-openai') throw new Error('KMS Encrypt denied');
      return `enc:${pt}`;
    });

    await expect(reencryptOrgSecrets('org-1', CAPTURED)).rejects.toThrow('KMS Encrypt denied');
    // The failure short-circuits BEFORE any row is touched — no partial,
    // silently-lost secret.
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockIdpUpdateOne).not.toHaveBeenCalled();
  });

  it('wraps EVERY secret before writing any: a failure on the last one leaves nothing written (written: false)', async () => {
    mockWrap.mockImplementation((pt: unknown) => {
      if (pt === 'idp-plain') throw new Error('KMS Encrypt denied');
      return `enc:${pt}`;
    });

    const err = await reencryptOrgSecrets('org-1', CAPTURED).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSecretsReencryptError);
    expect((err as InstanceType<typeof OrgSecretsReencryptError>).written).toBe(false);
    expect((err as Error).message).toMatch(/KMS Encrypt denied/);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockIdpUpdateOne).not.toHaveBeenCalled();
  });

  it('a write failure after a write landed reports written: true', async () => {
    mockIdpUpdateOne.mockRejectedValue(new Error('mongo down'));

    const err = await reencryptOrgSecrets('org-1', CAPTURED).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSecretsReencryptError);
    expect((err as InstanceType<typeof OrgSecretsReencryptError>).written).toBe(true);
    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(2);
  });

  it('a failure after only non-matching writes still reports written: false', async () => {
    // Every AI-key filter misses (nothing written), then the re-read fails.
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 0 });
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });

    const err = await reencryptOrgSecrets('org-1', CAPTURED).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSecretsReencryptError);
    expect((err as InstanceType<typeof OrgSecretsReencryptError>).written).toBe(false);
    expect(mockIdpUpdateOne).not.toHaveBeenCalled();
  });

  it('a concurrent value already under the new key counts as written: a restore would strand it', async () => {
    // Nothing of ours lands, but the store now holds a new-key blob, then a later step fails.
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 0 });
    mockOrgFindById.mockReturnValue(leanDoc({ aiProviderKeys: { openai: 'enc:fresh-openai' } }));
    mockUnwrap.mockImplementation((raw: unknown) => `plain:${raw}`);
    mockIdpUpdateOne.mockResolvedValue({ matchedCount: 0 });
    mockIdpFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });

    const err = await reencryptOrgSecrets('org-1', CAPTURED).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrgSecretsReencryptError);
    expect((err as InstanceType<typeof OrgSecretsReencryptError>).written).toBe(true);
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
    // The exact stored blobs are kept, so phase 3 can write conditionally on them.
    expect(captured.blobs).toEqual({ aiKeys: { openai: 'cipher-openai' }, idpClientSecret: 'cipher-idp' });
  });
});

describe('reencryptAllStoredSecrets (SECRET_ENCRYPTION_KEY rotation)', () => {
  it('re-wraps every org AI key and every IdP secret, reporting counts', async () => {
    const orgA: any = { _id: 'org-a', aiProviderKeys: { anthropic: 'old-a', openai: 'old-o' }, markModified: jest.fn<AnyFn>(), save: jest.fn(async () => undefined) };
    const orgB: any = { _id: 'org-b', aiProviderKeys: undefined, markModified: jest.fn<AnyFn>(), save: jest.fn(async () => undefined) };
    mockOrgFind.mockReturnValue(cursorOver([orgA, orgB]));
    mockIdpFind.mockReturnValue(cursorOver([{ _id: 'idp-1', organizationId: 'org-a', clientSecretEncrypted: 'old-idp' }]));
    mockTotpFind.mockReturnValue(cursorOver([{ _id: 'totp-1', userId: 'u-1', secret: 'old-totp' }]));
    mockSamlFind.mockReturnValue(bareCursorOver([
      { _id: 'signing', privateKeyEncrypted: 'old-sign' },
      { _id: 'encryption', privateKeyEncrypted: 'old-enc' },
    ]));
    mockUnwrap.mockImplementation((raw: unknown) => `plain:${raw}`);

    const summary = await reencryptAllStoredSecrets();

    expect(summary).toEqual({
      orgsScanned: 2,
      aiKeysReencrypted: 2,
      idpSecretsReencrypted: 1,
      totpSecretsReencrypted: 1,
      samlSpKeysReencrypted: 2,
      failures: [],
    });
    // Authenticator secrets are salted per USER, and the SP keys per deployment
    // — neither is reachable from the org sweep, which is how they were missed.
    expect(mockTotpUpdateOne).toHaveBeenCalledWith({ _id: 'totp-1' }, { $set: { secret: 'enc:plain:old-totp' } });
    expect(mockUnwrap).toHaveBeenCalledWith('old-totp', 'user:u-1', 'totp.secret');
    expect(mockWrap).toHaveBeenCalledWith('plain:old-totp', 'user:u-1');
    expect(mockSamlUpdateOne).toHaveBeenCalledWith({ _id: 'signing' }, { $set: { privateKeyEncrypted: 'enc:plain:old-sign' } });
    expect(mockUnwrap).toHaveBeenCalledWith('old-sign', 'saml-sp-keys', 'saml-sp.signing');
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
    const orgA: any = { _id: 'org-a', aiProviderKeys: { anthropic: 'broken', openai: 'old-o' }, markModified: jest.fn<AnyFn>(), save: jest.fn(async () => undefined) };
    mockOrgFind.mockReturnValue(cursorOver([orgA]));
    mockIdpFind.mockReturnValue(cursorOver([]));
    mockTotpFind.mockReturnValue(cursorOver([]));
    mockSamlFind.mockReturnValue(bareCursorOver([]));
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

  it('records an unreadable TOTP secret or SP key under its own scope, never reporting a clean run', async () => {
    mockOrgFind.mockReturnValue(cursorOver([]));
    mockIdpFind.mockReturnValue(cursorOver([]));
    mockTotpFind.mockReturnValue(cursorOver([{ _id: 'totp-1', userId: 'u-1', secret: 'broken' }]));
    mockSamlFind.mockReturnValue(bareCursorOver([{ _id: 'signing', privateKeyEncrypted: 'broken' }]));
    mockUnwrap.mockImplementation(() => { throw new Error('bad auth tag'); });

    const summary = await reencryptAllStoredSecrets();

    // The whole point: the operator must NOT see zero failures and then drop
    // SECRET_ENCRYPTION_KEY_PREVIOUS — that would brick every enrolment.
    expect(summary.totpSecretsReencrypted).toBe(0);
    expect(summary.samlSpKeysReencrypted).toBe(0);
    expect(summary.failures).toEqual([
      { orgId: 'user:u-1', field: 'totp.secret', error: 'bad auth tag' },
      { orgId: 'saml-sp-keys', field: 'saml-sp.signing', error: 'bad auth tag' },
    ]);
    expect(mockTotpUpdateOne).not.toHaveBeenCalled();
    expect(mockSamlUpdateOne).not.toHaveBeenCalled();
  });
});
