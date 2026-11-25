// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org KMS rotation (PUT / DELETE .../kms-config) hands the pipeline
 * service's runner signing keys to `reencryptRunnerSigningKeys` after its own
 * Mongo pass, with the config the keys were written under — and REPORTS a
 * failure (500 + audit details), never swallows it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { z } from 'zod';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockOrgFindById = jest.fn<AnyFn>();
const mockOrgUpdateOne = jest.fn<AnyFn>();
const mockAudit = jest.fn<AnyFn>();
const mockCapture = jest.fn<AnyFn>();
const mockReencryptOrg = jest.fn<AnyFn>();
const mockRunnerReencrypt = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  getDefaultKeyProvider: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (...a: unknown[]) => mockOrgFindById(...a),
    updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a),
  },
}));
class OrgSecretsReencryptError extends Error {
  constructor(message: string, readonly written: boolean) { super(message); }
}
jest.unstable_mockModule('../src/services/secret-reencrypt.js', () => ({
  OrgSecretsReencryptError,
  captureOrgSecrets: (...a: unknown[]) => mockCapture(...a),
  reencryptOrgSecrets: (...a: unknown[]) => mockReencryptOrg(...a),
}));
/** The verification marker the save writes (helpers/org-kms-config.ts kmsVerifySchedule). */
const DUE = expect.any(Date);
jest.unstable_mockModule('../src/services/runner-key-reencrypt.js', () => ({
  reencryptRunnerSigningKeys: (...a: unknown[]) => mockRunnerReencrypt(...a),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  orgKmsConfigSchema: z.object({ keyId: z.string().min(1), ciphertextBase64: z.string().min(1) }),
  validateBody: (schema: any, body: unknown, res: any) => {
    const result = schema.safeParse(body);
    if (!result.success) { res.status(400).json({ success: false }); return null; }
    return result.data;
  },
}));

const { putOrgKmsConfig, deleteOrgKmsConfig, retryRunnerKeyReencrypt } = await import('../src/controllers/org-kms-config.js');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SYSADMIN = { sub: 'sa-1', isSuperAdmin: true };
const OLD = { keyId: 'alias/old', ciphertextBase64: 'T0xE' };
const NEW = { keyId: 'alias/new', ciphertextBase64: 'TkVX' };

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}
function orgDoc(kmsConfig?: unknown) {
  return { _id: ORG, kmsConfig };
}
/** The conditional save, as recorded by the updateOne mock. */
const save = mockOrgUpdateOne;
const put = async (query: Record<string, string> = {}) => {
  const res = mockRes();
  await (putOrgKmsConfig as any)({ params: { orgId: ORG }, query, body: NEW, user: SYSADMIN, headers: {} }, res);
  return res;
};
const del = async (query: Record<string, string> = {}) => {
  const res = mockRes();
  await (deleteOrgKmsConfig as any)({ params: { orgId: ORG }, query, user: SYSADMIN, headers: {} }, res);
  return res;
};

const OK = { ok: true, counts: { scanned: 2, reencrypted: 2, failures: [] } };

beforeEach(() => {
  jest.clearAllMocks();
  mockCapture.mockResolvedValue([]);
  mockReencryptOrg.mockResolvedValue({ aiKeysReencrypted: 0, idpSecretReencrypted: false, concurrentlyChanged: [], unreadableConcurrentWrites: [] });
  mockRunnerReencrypt.mockResolvedValue(OK);
  mockOrgUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});

describe('PUT kms-config: runner signing keys', () => {
  it('re-encrypts the org\'s runner keys AFTER the Mongo pass, naming the previous config', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    const res = await put();
    expect(res.statusCode).toBe(200);
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
    expect(mockReencryptOrg.mock.invocationCallOrder[0]).toBeLessThan(mockRunnerReencrypt.mock.invocationCallOrder[0]);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(mockRunnerReencrypt.mock.invocationCallOrder[0]);
    expect(res.body.data).toMatchObject({ configured: true, runnerKeysReencrypted: 2 });
  });

  it('previousKmsConfig is null for an org that was on the shared provider', async () => {
    mockOrgFindById.mockReturnValue(orgDoc(undefined));
    await put();
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: null });
  });

  it('reports a failed runner-key re-encrypt: 500 and the error in the audit details', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'Runner signing key re-encryption failed: pipeline service unreachable' });
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toMatch(/pipeline service unreachable/);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.org.kms-config.upsert', expect.objectContaining({
      details: expect.objectContaining({ runnerKeysReencryptError: expect.stringMatching(/unreachable/) }),
    }));
  });

  it('reports rows the pipeline service could not re-wrap', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    const failures = [{ orgId: ORG, kid: 'kid-1', error: 'decrypt failed' }];
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'left 1 key(s) unreadable', counts: { scanned: 1, reencrypted: 0, failures } });
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ details: { runnerKeyFailures: failures } });
  });

  it('marks a failed runner-key re-encrypt as a failure outcome in the audit row', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'pipeline service unreachable' });
    await put();
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ outcome: 'failure' });
  });

  it('a Mongo re-encrypt failure still re-wraps the runner keys (the previous config is gone once saved) and is audited', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockRejectedValue(new Error('kms throttled'));
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toMatch(/kms throttled/);
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.org.kms-config.upsert', expect.objectContaining({
      outcome: 'failure',
      details: expect.objectContaining({ secretsReencryptError: expect.stringMatching(/kms throttled/), runnerKeysReencrypted: 2 }),
    }));
  });

  it('?reencrypt=false skips only the Mongo secret re-encrypt; the runner keys are still re-wrapped', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    const res = await put({ reencrypt: 'false' });
    expect(res.statusCode).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockReencryptOrg).not.toHaveBeenCalled();
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
    expect(res.body.data).toMatchObject({ configured: true, runnerKeysReencrypted: 2 });
  });

  it('?reencrypt=false still reports a failed runner-key re-wrap (500)', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'pipeline service unreachable' });
    const res = await put({ reencrypt: 'false' });
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toMatch(/pipeline service unreachable/);
  });

  it('a failed capture answers 409 naming ?reencrypt=false as skipping only the platform secrets', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockCapture.mockRejectedValue(new Error('bad row'));
    const res = await put();
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/\?reencrypt=false/);
    expect(res.body.message).toMatch(/platform secrets/i);
    expect(res.body.message).toMatch(/runner signing keys are still re-wrapped/i);
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });
});

describe('DELETE kms-config: runner signing keys', () => {
  it('moves the org\'s runner keys back to the shared provider, naming the cleared config', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
  });

  it('reports a failure (500, audited) rather than answering configured: false', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'Runner signing key re-encryption failed: pipeline service responded HTTP 500' });
    const res = await del();
    expect(res.statusCode).toBe(500);
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ outcome: 'failure', details: { runnerKeysReencryptError: expect.stringMatching(/HTTP 500/) } });
  });

  it('no config to clear: nothing to re-encrypt', async () => {
    mockOrgFindById.mockReturnValue(orgDoc(undefined));
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });

  it('no config to clear writes nothing', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({}));
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ configured: false, message: 'No KMS config to clear' });
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['a stray ciphertext with no keyId', { ciphertextBase64: 'c3RyYXk=' }],
    ['a keyId with no ciphertext', { keyId: 'alias/half' }],
  ])('%s is a partial config: DELETE clears it (no migration — nothing is wrapped under it) and audits it', async (_label, partial) => {
    mockOrgFindById.mockReturnValue(orgDoc(partial));
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ configured: false });
    expect(save).toHaveBeenCalledTimes(1);
    // Conditional on the org still having no ACTIVE config, so a concurrent PUT is never wiped.
    expect(save.mock.calls[0][0]).toHaveProperty('$or');
    expect(save.mock.calls[0][1]).toEqual({ $unset: { kmsConfig: 1 } });
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.org.kms-config.delete', expect.objectContaining({
      details: expect.objectContaining({ partialConfigCleared: true }),
    }));
  });

  it('a partial config a concurrent PUT completed meanwhile is left alone (409)', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ciphertextBase64: 'c3RyYXk=' }));
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const res = await del();
    expect(res.statusCode).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('re-encrypts the platform secrets: captured under the CMK BEFORE the clear, re-wrapped AFTER it', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockResolvedValue({ aiKeysReencrypted: 2, idpSecretReencrypted: true, concurrentlyChanged: [], unreadableConcurrentWrites: [] });
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(mockCapture).toHaveBeenCalledWith(ORG);
    expect(mockCapture.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(mockReencryptOrg.mock.invocationCallOrder[0]);
    expect(res.body.data).toMatchObject({ configured: false, aiKeysReencrypted: 2, idpSecretReencrypted: true });
  });

  it('a secret written under the OLD key mid-migration is reported and audited as a failure', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockResolvedValue({
      aiKeysReencrypted: 1,
      idpSecretReencrypted: true,
      concurrentlyChanged: ['aiProviderKeys.openai'],
      unreadableConcurrentWrites: ['aiProviderKeys.openai'],
    });
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ unreadableConcurrentWrites: ['aiProviderKeys.openai'] });
    expect(mockAudit.mock.calls[0][2]).toMatchObject({
      outcome: 'failure',
      details: { concurrentlyChanged: ['aiProviderKeys.openai'], unreadableConcurrentWrites: ['aiProviderKeys.openai'] },
    });
  });

  it('a failed capture refuses the clear (409) and leaves the config in place', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockCapture.mockRejectedValue(new Error('bad row'));
    const res = await del();
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/\?reencrypt=false/);
    expect(save).not.toHaveBeenCalled();
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });

  it('?reencrypt=false skips only the platform secrets; the runner keys are still re-wrapped', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    const res = await del({ reencrypt: 'false' });
    expect(res.statusCode).toBe(200);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockReencryptOrg).not.toHaveBeenCalled();
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
  });

  it('a platform-secret re-encrypt failure after the clear is a 500, audited as a failure', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockRejectedValue(new Error('kms throttled'));
    const res = await del();
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toMatch(/kms throttled/);
    expect(mockRunnerReencrypt).toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ outcome: 'failure', details: { secretsReencryptError: expect.stringMatching(/kms throttled/) } });
  });
});

describe('kms-config: concurrent changes', () => {
  /** A stateful org store: findById hands each request a snapshot of the
   *  stored config, updateOne applies a filter on keyId/ciphertext the way
   *  Mongo would. */
  function store(initial: { keyId: string; ciphertextBase64: string } | undefined) {
    let current = initial ? { ...initial } : undefined;
    mockOrgFindById.mockImplementation(async () => orgDoc(current ? { ...current } : undefined));
    mockOrgUpdateOne.mockImplementation(async (filter: any, update: any) => {
      const matches = filter['kmsConfig.keyId'] !== undefined
        ? current?.keyId === filter['kmsConfig.keyId'] && current?.ciphertextBase64 === filter['kmsConfig.ciphertextBase64']
        : !current?.keyId || !current?.ciphertextBase64;
      if (!matches) return { matchedCount: 0, modifiedCount: 0 };
      current = update.$set?.kmsConfig ? { ...update.$set.kmsConfig } : undefined;
      return { matchedCount: 1, modifiedCount: 1 };
    });
    return { get: () => current };
  }
  /** Both requests read and capture before either saves. */
  function slowCapture() {
    mockCapture.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 5)));
  }

  it('saves conditionally on the config it read', async () => {
    store({ ...OLD });
    await put();
    expect(mockOrgUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ '_id': ORG, 'kmsConfig.keyId': OLD.keyId, 'kmsConfig.ciphertextBase64': OLD.ciphertextBase64 }),
      { $set: { kmsConfig: NEW, kmsVerifyDueAt: DUE } },
    );
  });

  it('the save schedules the post-change verification in the same write (durable, and a later change supersedes it)', async () => {
    store({ ...OLD });
    await del();
    expect(mockOrgUpdateOne.mock.calls[0][1]).toEqual({ $unset: { kmsConfig: 1 }, $set: { kmsVerifyDueAt: DUE } });
  });

  it('a refused (409) change schedules nothing: its save never matched', async () => {
    store({ ...OLD });
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    await put();
    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('two concurrent PUTs: one rotates, the other gets 409 CONFLICT before re-encrypting', async () => {
    const db = store({ ...OLD });
    slowCapture();
    const [a, b] = await Promise.all([put(), put()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.body.message).toMatch(/changed by another request/);
    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockReencryptOrg).toHaveBeenCalledTimes(1);
    expect(mockRunnerReencrypt).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(db.get()).toEqual(NEW);
  });

  it('a PUT racing a DELETE: the loser is refused with 409 and nothing of its migration runs', async () => {
    store({ ...OLD });
    slowCapture();
    const [p, d] = await Promise.all([put(), del()]);
    expect([p.statusCode, d.statusCode].sort()).toEqual([200, 409]);
    expect(mockReencryptOrg).toHaveBeenCalledTimes(1);
    expect(mockRunnerReencrypt).toHaveBeenCalledTimes(1);
  });

  it('the 409 carries the CONFLICT error code', async () => {
    store({ ...OLD });
    mockOrgUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const res = await put();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
    expect(mockReencryptOrg).not.toHaveBeenCalled();
  });

  it('an org on the shared provider matches on having no active config', async () => {
    store(undefined);
    const res = await put();
    expect(res.statusCode).toBe(200);
    expect(mockOrgUpdateOne.mock.calls[0][0]).toHaveProperty('$or');
  });
});

describe('kms-config: re-encrypt failed before any secret was written', () => {
  const unwritten = () => new OrgSecretsReencryptError('KMS Encrypt denied for alias/new', false);

  it('PUT: restores the previous config (conditionally on the new one), skips the runner keys, answers 500', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockRejectedValue(unwritten());
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toMatch(/restored/i);
    expect(res.body.message).toMatch(/KMS Encrypt denied/);
    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockOrgUpdateOne.mock.calls[1]).toEqual([
      { '_id': ORG, 'kmsConfig.keyId': NEW.keyId, 'kmsConfig.ciphertextBase64': NEW.ciphertextBase64 },
      // The restore re-stamps the verification: a replica that picked up the
      // briefly-saved NEW config keeps it a full cache TTL from the restore.
      { $set: { kmsConfig: OLD, kmsVerifyDueAt: DUE } },
    ]);
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][2]).toMatchObject({
      outcome: 'failure',
      details: { secretsReencryptError: expect.stringMatching(/KMS Encrypt denied/), configRestored: true },
    });
  });

  it('PUT on an org that had no config: the restore unsets the new one', async () => {
    mockOrgFindById.mockReturnValue(orgDoc(undefined));
    mockReencryptOrg.mockRejectedValue(unwritten());
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(mockOrgUpdateOne.mock.calls[1][1]).toEqual({ $unset: { kmsConfig: 1 }, $set: { kmsVerifyDueAt: DUE } });
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });

  it('DELETE: puts the cleared config back, conditionally on the org still having none', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockRejectedValue(unwritten());
    const res = await del();
    expect(res.statusCode).toBe(500);
    expect(mockOrgUpdateOne.mock.calls[1][0]).toHaveProperty('$or');
    expect(mockOrgUpdateOne.mock.calls[1][1]).toEqual({ $set: { kmsConfig: OLD, kmsVerifyDueAt: DUE } });
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });

  it('when the restore no longer matches (changed again), the migration finishes as before', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockRejectedValue(unwritten());
    mockOrgUpdateOne
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(res.body.message).toMatch(/re-encryption failed mid-flight/);
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
  });

  it('a failure after a secret was written is never rolled back', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockReencryptOrg.mockRejectedValue(new OrgSecretsReencryptError('mongo down', true));
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockRunnerReencrypt).toHaveBeenCalled();
  });
});

describe('kms-config: recovering a failed runner-key re-wrap', () => {
  const retry = async () => {
    const res = mockRes();
    await (retryRunnerKeyReencrypt as any)({ params: { orgId: ORG }, query: {}, body: {}, user: SYSADMIN, headers: {} }, res);
    return res;
  };
  const PENDING = expect.any(Date);

  it('a failed re-wrap records the outgoing config durably (once — the oldest unmigrated config wins) and names the retry route', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'pipeline service unreachable' });
    const res = await put();
    expect(res.statusCode).toBe(500);
    expect(mockOrgUpdateOne).toHaveBeenCalledWith(
      { _id: ORG, kmsRunnerRewrapFrom: { $exists: false } },
      { $set: { kmsRunnerRewrapFrom: { keyId: OLD.keyId, ciphertextBase64: OLD.ciphertextBase64, pendingSince: PENDING } } },
    );
    expect(res.body.message).toMatch(/kms-config\/runner-keys\/reencrypt/);
    expect(res.body.message).not.toMatch(/rerun/);
  });

  it('a failed re-wrap from the shared provider records a marker with no config', async () => {
    mockOrgFindById.mockReturnValue(orgDoc(undefined));
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'pipeline service unreachable' });
    await put();
    expect(mockOrgUpdateOne).toHaveBeenCalledWith(
      { _id: ORG, kmsRunnerRewrapFrom: { $exists: false } },
      { $set: { kmsRunnerRewrapFrom: { pendingSince: PENDING } } },
    );
  });

  it('the retry re-runs the re-wrap with the RECORDED outgoing config and clears the marker on success', async () => {
    const since = new Date('2026-11-20T00:00:00Z');
    mockOrgFindById.mockReturnValue({ ...orgDoc({ ...NEW }), kmsRunnerRewrapFrom: { ...OLD, pendingSince: since } });
    const res = await retry();
    expect(res.statusCode).toBe(200);
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
    expect(mockOrgUpdateOne).toHaveBeenCalledWith(
      { '_id': ORG, 'kmsRunnerRewrapFrom.pendingSince': since },
      { $unset: { kmsRunnerRewrapFrom: 1 } },
    );
    expect(res.body.data).toMatchObject({ runnerKeysReencrypted: 2 });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.org.kms-config.runner-keys.reencrypt', expect.objectContaining({ affectedOrgId: ORG }));
  });

  it('a shared-provider marker retries with previousKmsConfig null', async () => {
    mockOrgFindById.mockReturnValue({ ...orgDoc({ ...NEW }), kmsRunnerRewrapFrom: { pendingSince: new Date() } });
    await retry();
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: null });
  });

  it('a retry that fails again answers 500 and keeps the marker', async () => {
    mockOrgFindById.mockReturnValue({ ...orgDoc({ ...NEW }), kmsRunnerRewrapFrom: { ...OLD, pendingSince: new Date() } });
    mockRunnerReencrypt.mockResolvedValue({ ok: false, error: 'pipeline service unreachable' });
    const res = await retry();
    expect(res.statusCode).toBe(500);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ outcome: 'failure' });
  });

  it('409 when no re-wrap is pending', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...NEW }));
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });

  // A change made while a re-wrap is pending would leave runner keys under TWO
  // configs (the recorded one and the one being replaced) with only one marker:
  // if its own re-wrap failed, the rows under the replaced config could never
  // be named again. So the pending re-wrap must be finished first.
  it('a PUT while a re-wrap is pending is refused (409) before anything is captured or written', async () => {
    mockOrgFindById.mockReturnValue({ ...orgDoc({ ...OLD }), kmsRunnerRewrapFrom: { keyId: 'alias/older', ciphertextBase64: 'T0xERVI=', pendingSince: new Date() } });
    const res = await put();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.message).toMatch(/kms-config\/runner-keys\/reencrypt/);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockRunnerReencrypt).not.toHaveBeenCalled();
  });

  it('a DELETE while a re-wrap is pending is refused too', async () => {
    mockOrgFindById.mockReturnValue({ ...orgDoc({ ...OLD }), kmsRunnerRewrapFrom: { pendingSince: new Date() } });
    const res = await del();
    expect(res.statusCode).toBe(409);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('the save is conditional on no re-wrap being pending (a failure recorded meanwhile refuses it)', async () => {
    mockOrgFindById.mockReturnValue(orgDoc({ ...OLD }));
    await put();
    expect(mockOrgUpdateOne.mock.calls[0][0]).toMatchObject({ kmsRunnerRewrapFrom: { $exists: false } });
  });
});
