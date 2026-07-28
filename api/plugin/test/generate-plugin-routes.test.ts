// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/generate-plugin.
 *
 * Focus: the aiCalls quota slot must be reserved/rolled back with a
 * SERVICE-minted auth header (getServiceAuthHeader), not the caller's user
 * bearer — the quota `/increment` endpoint rejects non-service principals, so
 * reserving with the user token 403s for every non-admin. Mirrors the
 * upload-plugin / deploy-generated-plugin quota-auth contract.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- Mocks (before imports) ---------------------------------------------------

const SERVICE_TOKEN = 'Bearer service-minted-token';
const mockGetServiceAuthHeader = jest.fn<(...args: any[]) => string>(() => SERVICE_TOKEN);
const mockReserveQuota = jest.fn<(...args: any[]) => any>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn();
const mockGeneratePluginConfig = jest.fn<(...args: any[]) => any>();
const mockStreamPluginConfig = jest.fn<(...args: any[]) => any>();

jest.unstable_mockModule('../src/services/ai-plugin-generation-service.js', () => ({
  getAvailableProviders: jest.fn(() => []),
  generatePluginConfig: mockGeneratePluginConfig,
  streamPluginConfig: mockStreamPluginConfig,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: mockGetServiceAuthHeader,
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  validateBody: jest.fn(() => ({ ok: true, value: { prompt: 'make a linter', provider: 'anthropic', model: 'claude', apiKey: undefined } })),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaExceeded: jest.fn((res: any) => res.status(429).json({ message: 'quota exceeded' })),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any) => res.status(statusCode).json({ success: true, data })),
  handleAIError: jest.fn((res: any, message: string) => res.status(502).json({ message })),
  initSSEStream: jest.fn(() => ({ aborted: () => false })),
  AIGenerateBodySchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    const requireOrgId = options?.requireOrgId !== false;
    if (requireOrgId && !orgId) return res.status(400).json({ message: 'Organization ID is required' });
    await handler({ req, res, ctx, orgId, userId });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { SSE_STREAM_TIMEOUT_MS: 300000 },
}));

const { createGeneratePluginRoutes } = await import('../src/routes/generate-plugin.js');
const { initSSEStream } = await import('@pipeline-builder/api-core');

// -- Helpers ------------------------------------------------------------------

const mockQuotaService = { increment: jest.fn(), reserve: jest.fn(), decrement: jest.fn() } as any;
const router = createGeneratePluginRoutes(mockQuotaService);

/** Return the terminal (withRoute) handler for a route — skips the requireFeature guard. */
function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    headers: { authorization: 'Bearer USER-BEARER-tok' },
    context: { identity: { orgId: 'ORG-1', userId: 'user-9' }, log: jest.fn(), requestId: 'req-1' },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.write = jest.fn().mockReturnValue(true);
  res.end = jest.fn().mockReturnValue(res);
  return res;
}

// -- Tests --------------------------------------------------------------------

describe('POST /generate — quota reserve auth', () => {
  const handler = getHandler('post', '/generate');

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServiceAuthHeader.mockReturnValue(SERVICE_TOKEN);
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } });
  });

  it('reserves aiCalls with a service-minted header, NOT the user bearer', async () => {
    mockGeneratePluginConfig.mockResolvedValue({ config: { name: 'x' }, dockerfile: 'FROM node' });

    await handler(mockReq(), mockRes());

    // Service token minted for the org with role 'member'.
    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'plugin', orgId: 'org-1', role: 'member' });
    // reserveQuota received the SERVICE token, not 'Bearer USER-BEARER-tok'.
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
    expect(mockReserveQuota).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'Bearer USER-BEARER-tok',
    );
  });

  it('rolls back with the service header when generation throws', async () => {
    mockGeneratePluginConfig.mockRejectedValue(new Error('LLM down'));

    await handler(mockReq(), mockRes());

    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN, expect.any(Function), 1, '2026-08-01T00:00:00Z',
    );
  });

  it('returns 429 (not 403) when the org is at its aiCalls cap', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'aiCalls', limit: 1, used: 1, remaining: 0, resetAt: '2026-08-01T00:00:00Z' } });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockGeneratePluginConfig).not.toHaveBeenCalled();
  });
});

describe('POST /generate/stream — quota reserve auth', () => {
  const handler = getHandler('post', '/generate/stream');

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetServiceAuthHeader.mockReturnValue(SERVICE_TOKEN);
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } });
    mockStreamPluginConfig.mockReturnValue({
      partialOutputStream: (async function* () { /* no partials */ })(),
      output: Promise.resolve({ dockerfile: 'FROM node', name: 'x' }),
    });
  });

  it('reserves aiCalls with the service-minted header', async () => {
    await handler(mockReq(), mockRes());

    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'plugin', orgId: 'org-1', role: 'member' });
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
    expect(mockReserveQuota).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'Bearer USER-BEARER-tok',
    );
  });

  // Quota refund policy — a COMPLETED stream KEEPS the reserved aiCalls slot even
  // when the AI produced empty/unparseable final output: the provider round-trip
  // (and its $ cost) was incurred. This matches generate-pipeline.ts; the plugin
  // path previously refunded here, which is the inconsistency this aligns.
  it('does NOT refund the aiCalls slot on a completed but empty stream', async () => {
    (initSSEStream as jest.Mock).mockReturnValue({ aborted: () => false });
    mockStreamPluginConfig.mockReturnValue({
      partialOutputStream: (async function* () { /* no partials */ })(),
      output: Promise.resolve(null), // completed, but empty/unparseable output
    });

    const res = mockRes();
    await handler(mockReq(), res);

    // No `type:'done'` event, but the stream still terminates cleanly with [DONE].
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith('data: [DONE]\n\n');
    expect(res.end).toHaveBeenCalled();
  });

  // The ABORT (client disconnect) refund path stays intact — the caller never
  // consumed the output, so the reserved slot is returned.
  it('refunds the aiCalls slot when the stream is aborted before completion', async () => {
    (initSSEStream as jest.Mock).mockReturnValue({ aborted: () => true });
    mockStreamPluginConfig.mockReturnValue({
      partialOutputStream: (async function* () { /* no partials */ })(),
      output: Promise.resolve({ dockerfile: 'FROM node', name: 'x' }),
    });

    await handler(mockReq(), mockRes());

    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN, expect.any(Function), 1, '2026-08-01T00:00:00Z',
    );
  });
});
