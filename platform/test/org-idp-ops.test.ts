// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared per-org IdP write operations.
 *
 * These existed as two near-verbatim controller copies with NO controller-level
 * test, which is how they drifted: the self-service PUT preserved the stored
 * client secret when the body omitted it and the sysadmin PUT did not, so the
 * same edit behaved differently depending on which page made it. The behaviour
 * is now shared, and these tests pin it for BOTH surfaces.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
// Real-shaped response helpers: these tests assert on the status code the ops
// produce, so the send* helpers must actually write to the res double.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, code: number, body: unknown) => res.status(code).json({ success: true, data: body }),
  sendError: (res: any, code: number, message: string) => res.status(code).json({ success: false, message }),
  sendQuotaReserveDenied: (res: any, _type: string, r: { unavailable?: boolean }) => res.status(r.unavailable ? 503 : 429).json({ success: false, message: r.unavailable ? 'quota unavailable' : 'quota exceeded' }),
}));

const findByOrg = jest.fn<(orgId: string) => Promise<unknown>>();
const getLoginConfig = jest.fn<(orgId: string) => Promise<unknown>>();
const upsert = jest.fn<(userId: string, input: unknown) => Promise<unknown>>();
const patch = jest.fn<(orgId: string, userId: string, input: unknown) => Promise<unknown>>();
const del = jest.fn<(orgId: string) => Promise<boolean>>();
jest.unstable_mockModule('../src/services/org-idp-service.js', () => ({
  orgIdpService: { findByOrg, getLoginConfig, upsert, patch, delete: del },
}));

const audit = jest.fn();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit }));

const reserveFeatureQuota = jest.fn<(orgId: string, f: string) => Promise<unknown>>();
const releaseFeatureQuota = jest.fn();
jest.unstable_mockModule('../src/middleware/quota.js', () => ({ reserveFeatureQuota, releaseFeatureQuota }));

// `utils/validation.js` pulls in the config module, which (correctly) refuses to
// load without its secrets outside development — jest sets NODE_ENV=test, so the
// production guards are live here. Set them before the dynamic import below.
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const { upsertOrgIdp, patchOrgIdp, deleteOrgIdp, readOrgIdp } =
  await import('../src/controllers/org-idp-ops.js');

/** A valid full IdP body MINUS the client secret — the shape the UI submits on
 *  an edit, since the secret field is write-only and comes back blank. */
const EDIT_BODY = {
  provider: 'generic-oidc',
  discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
  clientId: 'client-abc',
  enabled: true,
};

function mockReq(body: Record<string, unknown>) {
  return { body, params: {}, user: { sub: 'user-1' } } as never;
}
function mockRes() {
  const r: Record<string, unknown> = { statusCode: 0, body: undefined };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: unknown) => { r.body = b; return r; });
  return r as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  findByOrg.mockResolvedValue(null);
  upsert.mockResolvedValue({ provider: 'generic-oidc' });
  patch.mockResolvedValue({ provider: 'generic-oidc' });
  del.mockResolvedValue(true);
  reserveFeatureQuota.mockResolvedValue({ exceeded: false, quota: { resetAt: null } });
});

describe.each(['admin', 'self-service'] as const)('upsertOrgIdp — %s surface', (surface) => {
  it('REGRESSION: preserves the stored client secret when the body omits it', async () => {
    // The IdP form is WRITE-ONLY for the secret (never sent back on read), so an
    // edit that changes any other field arrives without it. Both surfaces must
    // re-inject the stored value; only one of them used to.
    findByOrg.mockResolvedValue({ id: 'cfg-1' });
    getLoginConfig.mockResolvedValue({ clientSecret: 'stored-secret' });

    await upsertOrgIdp(mockReq({ ...EDIT_BODY }), mockRes(), 'org-1', surface);

    expect(upsert).toHaveBeenCalledTimes(1);
    const submitted = upsert.mock.calls[0][1] as { clientSecret?: string };
    expect(submitted.clientSecret).toBe('stored-secret');
  });

  it('uses a caller-supplied secret in preference to the stored one', async () => {
    findByOrg.mockResolvedValue({ id: 'cfg-1' });
    getLoginConfig.mockResolvedValue({ clientSecret: 'stored-secret' });

    await upsertOrgIdp(mockReq({ ...EDIT_BODY, clientSecret: 'rotated' }), mockRes(), 'org-1', surface);

    expect((upsert.mock.calls[0][1] as { clientSecret?: string }).clientSecret).toBe('rotated');
  });

  it('does NOT invent a secret on a fresh create — the required-secret rule still applies', async () => {
    findByOrg.mockResolvedValue(null); // no existing config
    await upsertOrgIdp(mockReq({ ...EDIT_BODY }), mockRes(), 'org-1', surface);

    expect(getLoginConfig).not.toHaveBeenCalled();
    // Validation rejects the secret-less create, so nothing is written.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('pins the write to the URL org, ignoring a body orgId', async () => {
    findByOrg.mockResolvedValue({ id: 'cfg-1' });
    getLoginConfig.mockResolvedValue({ clientSecret: 's' });

    await upsertOrgIdp(mockReq({ ...EDIT_BODY, orgId: 'other-org' }), mockRes(), 'org-1', surface);

    expect((upsert.mock.calls[0][1] as { orgId?: string }).orgId).toBe('org-1');
  });

  it('reserves a quota slot only on a fresh insert', async () => {
    findByOrg.mockResolvedValue({ id: 'cfg-1' });
    getLoginConfig.mockResolvedValue({ clientSecret: 's' });
    await upsertOrgIdp(mockReq({ ...EDIT_BODY }), mockRes(), 'org-1', surface);
    expect(reserveFeatureQuota).not.toHaveBeenCalled();
  });

  it('answers 503 — not "quota exceeded" — when the quota service could not confirm the slot', async () => {
    findByOrg.mockResolvedValue(null);
    reserveFeatureQuota.mockResolvedValue({ exceeded: true, unavailable: true, quota: { resetAt: null } });
    const res = mockRes() as unknown as { statusCode: number };

    await upsertOrgIdp(mockReq({ ...EDIT_BODY, clientSecret: 'new' }), res as never, 'org-1', surface);

    expect(res.statusCode).toBe(503);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('releases the reserved slot when the write throws', async () => {
    findByOrg.mockResolvedValue(null);
    upsert.mockRejectedValue(new Error('db down'));

    await expect(
      upsertOrgIdp(mockReq({ ...EDIT_BODY, clientSecret: 'new' }), mockRes(), 'org-1', surface),
    ).rejects.toThrow('db down');

    expect(reserveFeatureQuota).toHaveBeenCalledTimes(1);
    expect(releaseFeatureQuota).toHaveBeenCalledWith('org-1', 'idpConfigs', expect.anything());
  });

  it('records the surface on the audit event', async () => {
    findByOrg.mockResolvedValue({ id: 'cfg-1' });
    getLoginConfig.mockResolvedValue({ clientSecret: 's' });

    await upsertOrgIdp(mockReq({ ...EDIT_BODY }), mockRes(), 'org-1', surface);

    // The trail must distinguish an operator acting FOR a customer from the
    // customer's own admin acting for themselves.
    expect(audit.mock.calls[0][2]).toMatchObject({ details: { surface } });
  });
});

describe.each(['admin', 'self-service'] as const)('patch/delete — %s surface', (surface) => {
  it('404s a patch when the org has no config', async () => {
    patch.mockResolvedValue(null);
    const res = mockRes();
    await patchOrgIdp(mockReq({ enabled: false }), res, 'org-1', surface);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it('404s a delete when the org has no config, and releases no quota', async () => {
    del.mockResolvedValue(false);
    const res = mockRes();
    await deleteOrgIdp(mockReq({}), res, 'org-1', surface);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(404);
    expect(releaseFeatureQuota).not.toHaveBeenCalled();
  });

  it('gives the quota slot back on a successful delete', async () => {
    await deleteOrgIdp(mockReq({}), mockRes(), 'org-1', surface);
    expect(releaseFeatureQuota).toHaveBeenCalledWith('org-1', 'idpConfigs', expect.anything());
    expect(audit.mock.calls[0][2]).toMatchObject({ details: { surface } });
  });
});

describe('readOrgIdp', () => {
  it('returns 200 with config: null when the org has none (a normal state, not a 404)', async () => {
    findByOrg.mockResolvedValue(null);
    const res = mockRes();
    await readOrgIdp(res, 'org-1');
    expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
  });
});
