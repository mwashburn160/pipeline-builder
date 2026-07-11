// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `testOrgKmsConfig` controller (POST .../kms-config/test).
 *
 * The endpoint's contract: validate the body, look up the org, build an
 * ephemeral PerOrgKmsKeyProvider, derive a 32-byte key, and return a
 * fingerprint — without ever mutating Mongo. The failure paths matter
 * most because the whole point of the dry-run is to surface KMS / IAM
 * misconfiguration BEFORE a PUT triggers a real rotation.
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { z } from 'zod';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockOrgFindById = jest.fn();
const mockRequireSystemAdmin = jest.fn();
const mockDeriveKeyAsync = jest.fn();
const mockPerOrgCtor = jest.fn();
const mockAudit = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  // The controller constructs `new PerOrgKmsKeyProvider({ resolver, fallback })`
  // and calls `provider.deriveKeyAsync(orgId)`. We capture the ctor args + return
  // a fake provider whose deriveKeyAsync we control per-test.
  PerOrgKmsKeyProvider: jest.fn(function (opts: unknown) {
    mockPerOrgCtor(opts);
    return { deriveKeyAsync: (orgId: string) => mockDeriveKeyAsync(orgId) };
  }),
  EnvKeyProvider: jest.fn(function () { /* opaque fallback */ }),
  getDefaultKeyProvider: jest.fn(() => ({})),
}));

jest.unstable_mockModule('mongoose', () => {
  // Functional ObjectId so `toOrgId` (org-id.js) can run: 24-hex → ObjectId,
  // else the string unchanged. Include a `default` export (org-id.js default-imports mongoose).
  class ObjectId {
    v: unknown;
    constructor(v?: unknown) { this.v = v; }
    toString() { return String(this.v); }
    static isValid(v: unknown) { return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v); }
  }
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId };
  }
  const api = { Types: { Mixed: class {}, ObjectId }, Schema, models: {}, model: jest.fn() };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireSystemAdmin: (req: any, res: any) => mockRequireSystemAdmin(req, res),
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (...a: unknown[]) => mockOrgFindById(...a),
  },
}));

// The controller imports captureOrgSecrets + reencryptOrgSecrets for the
// PUT path; for testOrgKmsConfig they're irrelevant but still resolved.
jest.unstable_mockModule('../src/services/secret-reencrypt.js', () => ({
  captureOrgSecrets: jest.fn(),
  reencryptOrgSecrets: jest.fn(),
}));

// Post-zod migration the controller validates via utils/validation.js. The
// real module transitively loads config + the Mongoose user model; mock it
// with a faithful stand-in (same schema shape + 400-on-fail behavior) so this
// suite stays a focused unit test. The schema itself is covered in
// validation.test.ts.
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  orgKmsConfigSchema: z.object({
    keyId: z.string().min(1),
    ciphertextBase64: z.string().min(1).regex(/^[A-Za-z0-9+/=]+$/),
  }),
  validateBody: (schema: any, body: unknown, res: any) => {
    const result = schema.safeParse(body);
    if (!result.success) { res.status(400).json({ success: false, message: 'VALIDATION_ERROR' }); return null; }
    return result.data;
  },
}));

const { testOrgKmsConfig } = await import('../src/controllers/org-kms-config.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockOrgFindById.mockReset();
  mockRequireSystemAdmin.mockReset();
  mockDeriveKeyAsync.mockReset();
  mockPerOrgCtor.mockReset();
  mockAudit.mockReset();
});

describe('testOrgKmsConfig', () => {
  it('returns the sysadmin gate path if not authorized', async () => {
    mockRequireSystemAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ success: false });
      return false;
    });
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)({ params: { orgId: 'o1' } }, res);
    expect(mockOrgFindById).not.toHaveBeenCalled();
  });

  it('returns 400 when keyId is missing', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      { params: { orgId: 'o1' }, body: { ciphertextBase64: 'AQI=' } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when ciphertextBase64 is not base64', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      { params: { orgId: 'o1' }, body: { keyId: 'alias/pb', ciphertextBase64: 'not!base64!' } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the org does not exist', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      { params: { orgId: 'o1' }, body: { keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns a stable SHA-256 fingerprint on success and never touches Mongo for writes', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'o1' }) }) });
    mockDeriveKeyAsync.mockResolvedValue(Buffer.alloc(32, 0x11));

    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      { params: { orgId: 'o1' }, body: { keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0].data;
    expect(payload.ok).toBe(true);
    expect(payload.keyId).toBe('alias/pb');
    // 32 bytes of 0x11 → SHA-256 prefix is deterministic.
    expect(payload.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
    // The constructor was passed the proposed config via the resolver.
    expect(mockPerOrgCtor).toHaveBeenCalledWith(expect.objectContaining({
      resolver: expect.any(Function),
      fallback: expect.anything(),
    }));
  });

  it('returns 400 with the underlying KMS error message when deriveKey fails', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'o1' }) }) });
    mockDeriveKeyAsync.mockRejectedValue(new Error('AccessDenied: IAM cannot kms:Decrypt'));

    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      { params: { orgId: 'o1' }, body: { keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0].message).toMatch(/AccessDenied/);
  });
});
