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
const mockAudit = jest.fn<AnyFn>();
const mockCapture = jest.fn<AnyFn>();
const mockReencryptOrg = jest.fn<AnyFn>();
const mockRunnerReencrypt = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  getDefaultKeyProvider: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));
jest.unstable_mockModule('../src/services/secret-reencrypt.js', () => ({
  captureOrgSecrets: (...a: unknown[]) => mockCapture(...a),
  reencryptOrgSecrets: (...a: unknown[]) => mockReencryptOrg(...a),
}));
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

const { putOrgKmsConfig, deleteOrgKmsConfig } = await import('../src/controllers/org-kms-config.js');

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
  return { kmsConfig, markModified: jest.fn(), save: jest.fn(async () => undefined) };
}
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
  mockReencryptOrg.mockResolvedValue({ aiKeysReencrypted: 0 });
  mockRunnerReencrypt.mockResolvedValue(OK);
});

describe('PUT kms-config: runner signing keys', () => {
  it('re-encrypts the org\'s runner keys AFTER the Mongo pass, naming the previous config', async () => {
    const org = orgDoc({ ...OLD });
    mockOrgFindById.mockReturnValue(org);
    const res = await put();
    expect(res.statusCode).toBe(200);
    expect(mockRunnerReencrypt).toHaveBeenCalledWith({ orgId: ORG, previousKmsConfig: OLD });
    expect(mockReencryptOrg.mock.invocationCallOrder[0]).toBeLessThan(mockRunnerReencrypt.mock.invocationCallOrder[0]);
    expect(org.save.mock.invocationCallOrder[0]).toBeLessThan(mockRunnerReencrypt.mock.invocationCallOrder[0]);
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

  it('re-encrypts the platform secrets: captured under the CMK BEFORE the clear, re-wrapped AFTER it', async () => {
    const org = orgDoc({ ...OLD });
    mockOrgFindById.mockReturnValue(org);
    mockReencryptOrg.mockResolvedValue({ aiKeysReencrypted: 2, idpSecretReencrypted: true });
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(mockCapture).toHaveBeenCalledWith(ORG);
    expect(mockCapture.mock.invocationCallOrder[0]).toBeLessThan(org.save.mock.invocationCallOrder[0]);
    expect(org.save.mock.invocationCallOrder[0]).toBeLessThan(mockReencryptOrg.mock.invocationCallOrder[0]);
    expect(res.body.data).toMatchObject({ configured: false, aiKeysReencrypted: 2, idpSecretReencrypted: true });
  });

  it('a failed capture refuses the clear (409) and leaves the config in place', async () => {
    const org = orgDoc({ ...OLD });
    mockOrgFindById.mockReturnValue(org);
    mockCapture.mockRejectedValue(new Error('bad row'));
    const res = await del();
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/\?reencrypt=false/);
    expect(org.save).not.toHaveBeenCalled();
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
