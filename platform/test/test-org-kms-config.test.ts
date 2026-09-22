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

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { z } from 'zod';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockOrgFindById = jest.fn<AnyFn>();
const mockDeriveKeyAsync = jest.fn<AnyFn>();
const mockPerOrgCtor = jest.fn<AnyFn>();
const mockAudit = jest.fn<AnyFn>();

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
  const api = { Types: { Mixed: class {}, ObjectId }, Schema, models: {}, model: jest.fn<AnyFn>() };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: {
    findById: (...a: unknown[]) => mockOrgFindById(...a),
  },
}));

// The controller imports captureOrgSecrets + reencryptOrgSecrets for the
// PUT path; for testOrgKmsConfig they're irrelevant but still resolved.
jest.unstable_mockModule('../src/services/secret-reencrypt.js', () => ({
  captureOrgSecrets: jest.fn<AnyFn>(),
  reencryptOrgSecrets: jest.fn<AnyFn>(),
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


/**
 * The route is `requireSystemAdmin`-gated and that gate now runs FOR REAL (see
 * helpers/controller-helper-mock.ts). Authority is therefore expressed in the
 * REQUEST — api-core's `isSystemAdmin` reads the JWT's `isSuperAdmin` claim —
 * rather than by stubbing the gate, so the gate itself is under test.
 */
const SYSADMIN = { sub: 'sa-1', isSuperAdmin: true };
/** A signed-in org admin: passes `ensureAuthenticated`, fails `isSystemAdmin`. */
const ORG_ADMIN = { sub: 'a-1', organizationId: 'o1', role: 'admin' };

/** Request fixture; `user` defaults to the platform admin the route requires. */
const asReq = (body: unknown, user: unknown = SYSADMIN) =>
  // NOTE: pass `null` (not `undefined`) for the anonymous case — an explicit
  // `undefined` would re-trigger the SYSADMIN default parameter.
  ({ params: { orgId: 'o1' }, body, user }) as any;

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockOrgFindById.mockReset();
  mockDeriveKeyAsync.mockReset();
  mockPerOrgCtor.mockReset();
  mockAudit.mockReset();
});

describe('testOrgKmsConfig', () => {
  it('401s an anonymous caller and never looks the org up', async () => {
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' }, null),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockDeriveKeyAsync).not.toHaveBeenCalled();
  });

  it('403s a mere ORG admin — per-org KMS config is platform-admin only', async () => {
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' }, ORG_ADMIN),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockDeriveKeyAsync).not.toHaveBeenCalled();
  });

  it('returns 400 when keyId is missing', async () => {
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ ciphertextBase64: 'AQI=' }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when ciphertextBase64 is not base64', async () => {
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ keyId: 'alias/pb', ciphertextBase64: 'not!base64!' }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the org does not exist', async () => {
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns a stable SHA-256 fingerprint on success and never touches Mongo for writes', async () => {
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'o1' }) }) });
    mockDeriveKeyAsync.mockResolvedValue(Buffer.alloc(32, 0x11));

    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock<AnyFn>).mock.calls[0][0].data;
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
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'o1' }) }) });
    mockDeriveKeyAsync.mockRejectedValue(new Error('AccessDenied: IAM cannot kms:Decrypt'));

    const res = mockRes();
    await (testOrgKmsConfig as unknown as (req: any, res: any) => Promise<void>)(
      asReq({ keyId: 'alias/pb', ciphertextBase64: 'AQICAH==' }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock<AnyFn>).mock.calls[0][0].message).toMatch(/AccessDenied/);
  });
});
