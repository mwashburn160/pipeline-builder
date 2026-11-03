// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/ai/*`: the org's AI switch + configured provider NAMES, and the decrypted
 * org key for an internal AI caller.
 *
 * What matters is what the key read does NOT do: it never answers a token scoped to a
 * different org, never answers a non-service principal, and its audit row carries the
 * provider name only — never key material.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const mockAudit = jest.fn();
const mockAccess = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockKey = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  isServicePrincipal: (req: any) => req.user?.principalType === 'service',
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  organizationService: {
    getAIAccess: (...a: unknown[]) => mockAccess(...a),
    readAIProviderKey: (...a: unknown[]) => mockKey(...a),
  },
}));

const { getOrgAIAccess, getOrgAIKey } = await import('../src/controllers/ai-internal.js');

function mockRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

const svc = (orgId = ORG) => ({ principalType: 'service', sub: 'service:ask', organizationId: orgId });
const call = async (fn: unknown, params: Record<string, string>, user: unknown = svc()) => {
  const res = mockRes();
  const req: any = { params, user, headers: {} };
  await (fn as any)(req, res);
  return { res, req };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue({ aiEnabled: true, providers: ['anthropic'] });
  mockKey.mockResolvedValue('sk-ant-PLAINTEXT');
});

describe('GET /internal/ai/access/:orgId', () => {
  it('answers the switch and provider NAMES', async () => {
    const { res } = await call(getOrgAIAccess, { orgId: ORG });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ aiEnabled: true, providers: ['anthropic'] });
  });

  it('refuses a token scoped to another org, and a non-service principal', async () => {
    expect((await call(getOrgAIAccess, { orgId: ORG }, svc('bbbbbbbbbbbbbbbbbbbbbbbb'))).res.statusCode).toBe(403);
    expect((await call(getOrgAIAccess, { orgId: ORG }, { sub: 'u', organizationId: ORG })).res.statusCode).toBe(403);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('400s a malformed org id and 404s an unknown org', async () => {
    expect((await call(getOrgAIAccess, { orgId: '../x' })).res.statusCode).toBe(400);
    mockAccess.mockResolvedValue(null);
    expect((await call(getOrgAIAccess, { orgId: ORG })).res.statusCode).toBe(404);
  });
});

describe('GET /internal/ai/keys/:orgId/:provider', () => {
  it('returns the key and audits the read with the provider name ONLY', async () => {
    const { res, req } = await call(getOrgAIKey, { orgId: ORG, provider: 'anthropic' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-PLAINTEXT' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'org.ai-key.read', {
      targetType: 'organization', targetId: ORG, affectedOrgId: ORG, details: { provider: 'anthropic' },
    });
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PLAINTEXT');
  });

  it('refuses a keyless or unknown provider, and 404s (unaudited) when the org has no key', async () => {
    expect((await call(getOrgAIKey, { orgId: ORG, provider: 'amazon-bedrock' })).res.statusCode).toBe(400);
    mockKey.mockResolvedValue(null);
    expect((await call(getOrgAIKey, { orgId: ORG, provider: 'openai' })).res.statusCode).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('never reads a key for a token scoped to a different org', async () => {
    const { res } = await call(getOrgAIKey, { orgId: ORG, provider: 'anthropic' }, svc('bbbbbbbbbbbbbbbbbbbbbbbb'));
    expect(res.statusCode).toBe(403);
    expect(mockKey).not.toHaveBeenCalled();
  });
});
