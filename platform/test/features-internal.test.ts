// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/features/:orgId` and the org-level feature resolution behind it:
 * tier defaults + account entitlements (pooled at the root for a team), no
 * user's overrides; answered only to a service token scoped to the org.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const docs = new Map<string, Record<string, unknown>>();
const mockLineage = jest.fn<(orgId: string) => Promise<{ rootOrgId: string }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isServicePrincipal: (req: any) => req.user?.principalType === 'service',
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveOrgLineage: (id: string) => mockLineage(id) }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (id: unknown) => ({ select: () => ({ lean: async () => docs.get(String(id)) ?? null }) }) },
}));

const { resolveOrgFeatures } = await import('../src/helpers/org-features.js');
const { getOrgFeatures } = await import('../src/controllers/features-internal.js');

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}
const call = async (orgId: string, user: unknown) => {
  const res = mockRes();
  await (getOrgFeatures as any)({ params: { orgId }, user, headers: {} }, res);
  return res;
};
const svc = (orgId = ORG) => ({ principalType: 'service', sub: 'service:pipeline', organizationId: orgId });

beforeEach(() => {
  docs.clear();
  mockLineage.mockReset();
});

describe('resolveOrgFeatures', () => {
  it('tier defaults plus the account\'s operator-granted entitlements', async () => {
    docs.set(ORG, { tier: 'unlimited', featureEntitlements: ['cross_account_runners'] });
    expect(await resolveOrgFeatures(ORG)).toContain('cross_account_runners');
    docs.set(ORG, { tier: 'unlimited', featureEntitlements: [] });
    expect(await resolveOrgFeatures(ORG)).not.toContain('cross_account_runners');
  });

  it('a team reads the entitlements pooled at its account root', async () => {
    docs.set(ORG, { tier: 'developer', featureEntitlements: [], parentOrgId: ROOT });
    docs.set(ROOT, { featureEntitlements: ['cross_account_runners'] });
    mockLineage.mockResolvedValue({ rootOrgId: ROOT });
    expect(await resolveOrgFeatures(ORG)).toContain('cross_account_runners');
  });

  it('an unknown or deleted org is null', async () => {
    expect(await resolveOrgFeatures(ORG)).toBeNull();
    docs.set(ORG, { tier: 'unlimited', deletedAt: new Date() });
    expect(await resolveOrgFeatures(ORG)).toBeNull();
  });
});

describe('GET /internal/features/:orgId', () => {
  it('answers a service token scoped to the org', async () => {
    docs.set(ORG, { tier: 'developer', featureEntitlements: ['cross_account_runners'] });
    const res = await call(ORG, svc());
    expect(res.statusCode).toBe(200);
    expect(res.body.data.features).toContain('cross_account_runners');
  });

  it('refuses a token scoped to another org, or a user token (403); unknown org 404; bad id 400', async () => {
    docs.set(ORG, { tier: 'developer' });
    expect((await call(ORG, svc('cccccccccccccccccccccccc'))).statusCode).toBe(403);
    expect((await call(ORG, { principalType: 'user', organizationId: ORG })).statusCode).toBe(403);
    expect((await call('dddddddddddddddddddddddd', svc('dddddddddddddddddddddddd'))).statusCode).toBe(404);
    expect((await call('not-an-id', svc('not-an-id'))).statusCode).toBe(400);
  });
});
