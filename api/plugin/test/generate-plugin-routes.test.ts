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
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- Mocks (before imports) ---------------------------------------------------

const SERVICE_TOKEN = 'Bearer service-minted-token';
const mockGetServiceAuthHeader = jest.fn<(...args: any[]) => string>(() => SERVICE_TOKEN);
const mockReserveQuota = jest.fn<(...args: any[]) => any>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn();
const mockGeneratePluginConfig = jest.fn<(...args: any[]) => any>();
const mockStreamPluginConfig = jest.fn<(...args: any[]) => any>();

/** Stand-in for the service's typed "provider answered, output empty" error. */
class MockAIEmptyOutputError extends Error {
  readonly providerContacted = true;
}

jest.unstable_mockModule('../src/services/ai-plugin-generation-service.js', () => ({
  AIEmptyOutputError: MockAIEmptyOutputError,
  dockerfileViolations: (dockerfile: string) => (dockerfile.includes('USER 1000:1000') ? [] : ['Dockerfile: the final stage sets no USER']),
  getAvailableProviders: jest.fn(() => []),
  generatePluginConfig: mockGeneratePluginConfig,
  streamPluginConfig: mockStreamPluginConfig,
}));

const SIMILAR = [{ id: 'p-1', name: 'eslint-lint', version: '2.0.0', category: 'quality', summary: 'Runs ESLint', keywords: ['lint'] }];
const mockFindSimilarPlugins = jest.fn<(...args: any[]) => Promise<any[]>>(() => Promise.resolve(SIMILAR));

jest.unstable_mockModule('../src/services/similar-plugin-lookup.js', () => ({
  findSimilarPlugins: mockFindSimilarPlugins,
}));

/** A fake SSE stream writing through the route's `res`, as the real one does. */
const sseFor = (aborted: boolean) => (_req: unknown, res: { write: (s: string) => void }) => ({
  signal: new AbortController().signal,
  aborted: () => aborted,
  send: (e: unknown) => { if (!aborted) res.write(`data: ${JSON.stringify(e)}\n\n`); },
  done: () => { if (!aborted) res.write('data: [DONE]\n\n'); },
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: mockGetServiceAuthHeader,
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  validateBody: jest.fn(() => ({ ok: true, value: { prompt: 'make a linter', provider: 'anthropic', model: 'claude', apiKey: undefined } })),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaReserveDenied: jest.fn((res: any, _t: string, r: { unavailable?: boolean }) => res.status(r.unavailable ? 503 : 429).json({ message: r.unavailable ? 'quota unavailable' : 'quota exceeded' })),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any) => res.status(statusCode).json({ success: true, data })),
  handleAIError: jest.fn((res: any, message: string) => res.status(502).json({ message })),
  initSSEStream: jest.fn(sseFor(false)),
  AIGenerateBodySchema: {},
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  rateLimitByOrg: () => (_req: any, _res: any, next: () => void) => next(),
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    const requireOrgId = options?.requireOrgId !== false;
    if (requireOrgId && !orgId) return res.status(400).json({ message: 'Organization ID is required' });
    await handler({ req, res, ctx, orgId, userId });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
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

  // Keep-on-provider-contact (pipeline's rule): the provider round-trip completed
  // and its cost was incurred, so an empty output KEEPS the slot.
  it('keeps the aiCalls slot when the provider answered with empty output', async () => {
    mockGeneratePluginConfig.mockRejectedValue(new MockAIEmptyOutputError('AI did not produce a plugin configuration'));

    const res = mockRes();
    await handler(mockReq(), res);

    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it('returns 429 (not 403) when the org is at its aiCalls cap', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'aiCalls', limit: 1, used: 1, remaining: 0, resetAt: '2026-08-01T00:00:00Z' } });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockGeneratePluginConfig).not.toHaveBeenCalled();
  });

  it('returns 503 (not a 429 "quota exceeded") when the quota service could not confirm the slot', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, unavailable: true, quota: { type: 'aiCalls', limit: 0, used: 0, remaining: 0 } });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
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
    (initSSEStream as jest.Mock<AnyFn>).mockImplementation(sseFor(false) as AnyFn);
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

  // Keep-on-provider-contact: once a partial has streamed the provider was
  // reached, so a later failure keeps the slot …
  it('keeps the aiCalls slot when the stream fails AFTER the provider responded', async () => {
    (initSSEStream as jest.Mock<AnyFn>).mockImplementation(sseFor(false) as AnyFn);
    mockStreamPluginConfig.mockReturnValue({
      partialOutputStream: (async function* () {
        yield { name: 'x' };
        throw new Error('stream reset mid-flight');
      })(),
      output: Promise.resolve(null),
    });

    await handler(mockReq(), mockRes());

    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  // … while a failure before the provider was ever reached refunds it.
  it('refunds the aiCalls slot when the stream fails BEFORE the provider responded', async () => {
    (initSSEStream as jest.Mock<AnyFn>).mockImplementation(sseFor(false) as AnyFn);
    mockStreamPluginConfig.mockImplementation(() => { throw new Error('unknown model'); });

    await handler(mockReq(), mockRes());

    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN, expect.any(Function), 1, '2026-08-01T00:00:00Z',
    );
  });

  // The ABORT (client disconnect) refund path stays intact — the caller never
  // consumed the output, so the reserved slot is returned.
  it('refunds the aiCalls slot when the stream is aborted before completion', async () => {
    (initSSEStream as jest.Mock<AnyFn>).mockImplementation(sseFor(true) as AnyFn);
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

// catalog context — the closest existing plugins go into the prompt and
// back to the caller as a `similarPlugins` hint.
describe('similarPlugins hint', () => {
  const generate = getHandler('post', '/generate');
  const stream = getHandler('post', '/generate/stream');

  beforeEach(() => {
    jest.clearAllMocks();
    mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-08-01T00:00:00Z' } });
    mockFindSimilarPlugins.mockResolvedValue(SIMILAR);
    (initSSEStream as jest.Mock<AnyFn>).mockImplementation(sseFor(false) as AnyFn);
  });

  it('POST /generate looks up similar plugins for the caller (with parent org), passes them to the model, and returns them', async () => {
    mockGeneratePluginConfig.mockResolvedValue({ config: { name: 'x' }, dockerfile: 'FROM node', dockerfileViolations: ['Dockerfile: the final stage sets no USER'] });
    const res = mockRes();

    await generate(mockReq({ user: { parentOrganizationId: 'parent-1' } }), res);

    expect(mockFindSimilarPlugins).toHaveBeenCalledWith('make a linter', 'org-1', 'parent-1');
    expect(mockGeneratePluginConfig).toHaveBeenCalledWith(expect.objectContaining({ similarPlugins: SIMILAR }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { config: { name: 'x' }, dockerfile: 'FROM node', dockerfileViolations: ['Dockerfile: the final stage sets no USER'], similarPlugins: SIMILAR },
    });
  });

  it('POST /generate still succeeds with an empty hint when the lookup yields nothing', async () => {
    mockFindSimilarPlugins.mockResolvedValue([]);
    mockGeneratePluginConfig.mockResolvedValue({ config: { name: 'x' }, dockerfile: 'FROM node' });
    const res = mockRes();

    await generate(mockReq(), res);

    expect(mockFindSimilarPlugins).toHaveBeenCalledWith('make a linter', 'org-1', undefined);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.similarPlugins).toEqual([]);
  });

  it('POST /generate/stream includes similarPlugins in the done event', async () => {
    mockStreamPluginConfig.mockReturnValue({
      partialOutputStream: (async function* () { yield { name: 'x' }; })(),
      output: Promise.resolve({ dockerfile: 'FROM node', name: 'x' }),
    });
    const res = mockRes();

    await stream(mockReq(), res);

    expect(mockStreamPluginConfig).toHaveBeenCalledWith(expect.objectContaining({ similarPlugins: SIMILAR }));
    const done = res.write.mock.calls
      .map((c: any[]) => c[0] as string)
      .find((line: string) => line.includes('"type":"done"'));
    expect(done).toBeDefined();
    const event = JSON.parse(done!.replace(/^data: /, ''));
    expect(event.data.similarPlugins).toEqual(SIMILAR);
    expect(event.data.dockerfile).toBe('FROM node');
    // The final Dockerfile is checked against the catalog rules; violations ride the done event.
    expect(event.data.dockerfileViolations).toEqual(['Dockerfile: the final stage sets no USER']);
  });
});
