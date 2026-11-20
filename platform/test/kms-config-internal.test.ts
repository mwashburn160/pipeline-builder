// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/kms-config/:orgId` (PLATFORM_INTERNAL.orgKmsConfig): the org's
 * per-org KMS config for the pipeline service's runner-key encryption. Returns
 * only the CMK id and the KMS-wrapped master — never any other org field.
 * The route's caller gate (`pipeline` only) is pinned by route-coverage.test.ts
 * and internal-contracts.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const docs = new Map<string, Record<string, unknown>>();
const selected: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (id: unknown) => ({
      select: (fields: string) => {
        selected.push(fields);
        return { lean: async () => docs.get(String(id)) ?? null };
      },
    }),
  },
}));

const { getOrgKmsConfigInternal } = await import('../src/controllers/kms-config-internal.js');

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}
const call = async (orgId: string) => {
  const res = mockRes();
  await (getOrgKmsConfigInternal as any)(
    { params: { orgId }, user: { principalType: 'service', sub: 'service:pipeline', organizationId: 'system' }, headers: {} },
    res,
  );
  return res;
};

beforeEach(() => {
  docs.clear();
  selected.length = 0;
});

describe('GET /internal/kms-config/:orgId', () => {
  it('returns the CMK id and wrapped master, and reads nothing else from the org', async () => {
    docs.set(ORG, {
      name: 'Acme',
      aiSecrets: { anthropic: 'enc' },
      kmsConfig: { keyId: 'alias/acme', ciphertextBase64: 'AQICAHg=' },
    });
    const res = await call(ORG);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ kmsConfig: { keyId: 'alias/acme', ciphertextBase64: 'AQICAHg=' } });
    expect(selected).toEqual(['kmsConfig']);
  });

  it('lowercases the org id from the contract', async () => {
    docs.set(ORG, { kmsConfig: { keyId: 'alias/acme', ciphertextBase64: 'AQICAHg=' } });
    expect((await call(ORG.toUpperCase())).statusCode).toBe(200);
  });

  it('kmsConfig is null when the org has no (or a partial) per-org config', async () => {
    docs.set(ORG, {});
    expect((await call(ORG)).body.data).toEqual({ kmsConfig: null });
    docs.set(ORG, { kmsConfig: { keyId: 'alias/acme' } });
    expect((await call(ORG)).body.data).toEqual({ kmsConfig: null });
  });

  it('404 for an unknown org; 400 for a malformed id', async () => {
    expect((await call(ORG)).statusCode).toBe(404);
    expect((await call('not-an-id')).statusCode).toBe(400);
  });

  it('a soft-deleted org still gets its config during the retention window (same as platform\'s own resolver)', async () => {
    docs.set(ORG, { deletedAt: new Date(), kmsConfig: { keyId: 'k', ciphertextBase64: 'AQ==' } });
    const res = await call(ORG);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ kmsConfig: { keyId: 'k', ciphertextBase64: 'AQ==' } });
  });
});
