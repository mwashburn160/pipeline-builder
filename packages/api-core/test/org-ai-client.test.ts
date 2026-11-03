// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org half of every AI call: the AI switch, configured providers and the org key,
 * read from platform's internal routes.
 *
 * The properties that matter: an unreachable platform is a FAILURE (never "enabled,
 * no org keys", which would bill the platform's key and ignore the switch), a key is
 * held only briefly, and no error message ever carries key material.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGet = jest.fn<(path: string, opts?: unknown) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ get: (path: string, opts?: unknown) => mockGet(path, opts) }),
}));
jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({
  getServiceAuthHeader: (o: { orgId: string }) => `Bearer svc-for-${o.orgId}`,
}));

const {
  fetchOrgAIAccess, fetchOrgAIKey, assertOrgAIEnabled, requireOrgAIEnabled, resetOrgAICache,
} = await import('../src/services/org-ai-client.js');

const ok = (data: unknown) => ({ statusCode: 200, body: { success: true, data } });

beforeEach(() => {
  mockGet.mockReset();
  resetOrgAICache();
});

describe('fetchOrgAIAccess', () => {
  it('reads the switch + provider names with a token scoped to the org, and caches it', async () => {
    mockGet.mockResolvedValue(ok({ aiEnabled: true, providers: ['anthropic', 7] }));
    expect(await fetchOrgAIAccess('org1')).toEqual({ aiEnabled: true, providers: ['anthropic'] });
    await fetchOrgAIAccess('org1');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/internal/ai/access/org1', { headers: { Authorization: 'Bearer svc-for-org1' } });
  });

  it('FAILS (503) when platform cannot answer — never assumes "enabled"', async () => {
    mockGet.mockResolvedValue(null);
    await expect(fetchOrgAIAccess('org1')).rejects.toMatchObject({ name: 'AIConfigurationError', statusCode: 503 });
    mockGet.mockResolvedValue({ statusCode: 500, body: {} });
    await expect(fetchOrgAIAccess('org2')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('assertOrgAIEnabled refuses a switched-off org with AI_DISABLED', async () => {
    mockGet.mockResolvedValue(ok({ aiEnabled: false, providers: [] }));
    await expect(assertOrgAIEnabled('org1')).rejects.toMatchObject({ code: 'AI_DISABLED', statusCode: 403 });
  });
});

describe('fetchOrgAIKey', () => {
  it('returns and briefly caches the key; reset drops it', async () => {
    mockGet.mockResolvedValue(ok({ provider: 'anthropic', apiKey: 'sk-ant-org' }));
    expect(await fetchOrgAIKey('org1', 'anthropic')).toBe('sk-ant-org');
    await fetchOrgAIKey('org1', 'anthropic');
    expect(mockGet).toHaveBeenCalledTimes(1);
    resetOrgAICache('org1');
    await fetchOrgAIKey('org1', 'anthropic');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('fails clearly, without echoing the response body, when the key cannot be loaded', async () => {
    mockGet.mockResolvedValue({ statusCode: 500, body: { message: 'decrypt failed for sk-ant-LEAK' } });
    const err = await fetchOrgAIKey('org1', 'anthropic').catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'AIConfigurationError' });
    expect((err as Error).message).toContain('NOT retried on the platform');
    expect((err as Error).message).not.toContain('LEAK');
  });
});

describe('requireOrgAIEnabled', () => {
  const res = () => {
    const r: Record<string, unknown> = { headersSent: false };
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    return r as never as { status: jest.Mock; json: jest.Mock };
  };

  it('passes an enabled org, refuses a disabled one (403) and an org-less request', async () => {
    mockGet.mockResolvedValue(ok({ aiEnabled: true, providers: [] }));
    const next = jest.fn();
    await requireOrgAIEnabled({ user: { organizationId: 'org1' } } as never, res() as never, next);
    expect(next).toHaveBeenCalled();

    resetOrgAICache();
    mockGet.mockResolvedValue(ok({ aiEnabled: false, providers: [] }));
    const off = res();
    await requireOrgAIEnabled({ user: { organizationId: 'org1' } } as never, off as never, jest.fn());
    expect(off.status).toHaveBeenCalledWith(403);

    const none = res();
    await requireOrgAIEnabled({ user: {} } as never, none as never, jest.fn());
    expect(none.status).toHaveBeenCalledWith(403);
  });
});
