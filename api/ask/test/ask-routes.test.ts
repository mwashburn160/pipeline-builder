// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/ask (read-only "Ask" agent).
 *
 * Focus: each turn reserves one `aiCalls` slot with a SERVICE-minted auth header
 * (the quota `/increment` endpoint rejects user principals), a completed answer
 * keeps the slot, a failure refunds it, and the stream emits sources → tokens →
 * done. The grounding/answer logic itself is covered in `@pipeline-builder/ai-core`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- Mocks (before imports) ---------------------------------------------------

const SERVICE_TOKEN = 'Bearer service-minted-token';

const mockAnswerHowTo = jest.fn<(...a: any[]) => any>();
const mockStreamHowTo = jest.fn<(...a: any[]) => any>();
const mockResolveModel = jest.fn<(...a: any[]) => any>(() => ({ id: 'model' }));
const mockCreateModelWithKey = jest.fn<(...a: any[]) => any>(() => ({ id: 'model' }));
const mockGetAvailableProviders = jest.fn<(...a: any[]) => any>(() => [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] }]);

jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  answerHowTo: mockAnswerHowTo,
  streamHowTo: mockStreamHowTo,
  resolveModel: mockResolveModel,
  createModelWithKey: mockCreateModelWithKey,
  getAvailableProviders: mockGetAvailableProviders,
  getProviderModels: jest.fn(() => [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }]),
}));

const mockGetServiceAuthHeader = jest.fn<(...a: any[]) => string>(() => SERVICE_TOKEN);
const mockReserveQuota = jest.fn<(...a: any[]) => any>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-09-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  getServiceAuthHeader: mockGetServiceAuthHeader,
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  // Route-table gate declarations on the ask routes (the real behaviour is
  // covered by the route-coverage test + api-core's own gate tests).
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  initSSEStream: jest.fn(() => ({ aborted: () => false })),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaReserveDenied: jest.fn((res: any, _t: string, r: { unavailable?: boolean }) => res.status(r.unavailable ? 503 : 429).json({ message: r.unavailable ? 'quota unavailable' : 'quota exceeded' })),
  sendSuccess: jest.fn((res: any, code: number, data?: any) => res.status(code).json({ success: true, data })),
  handleAIError: jest.fn((res: any, message: string) => res.status(502).json({ message })),
}));

jest.unstable_mockModule('../src/services/docs-index.js', () => ({
  getDocsIndex: jest.fn(async () => ({ search: () => [], size: 3 })),
}));

const auditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({ getAuditClient: () => ({ record: auditRecord }) }));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    if (!orgId) return res.status(400).json({ message: 'Organization ID is required' });
    await handler({ req, res, ctx, orgId, userId: ctx.identity.userId || '' });
  },
  incCounter: jest.fn(),
  observe: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { SSE_STREAM_TIMEOUT_MS: 300000 },
}));

const { createAskRoutes } = await import('../src/routes/ask.js');

// -- Helpers ------------------------------------------------------------------

const mockQuotaService = { increment: jest.fn(), reserve: jest.fn(), decrement: jest.fn() } as any;
const router = createAskRoutes(mockQuotaService);

/** Return the terminal (withRoute) handler for a route — skips requireFeature. */
function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(body: unknown): any {
  return {
    body,
    headers: { authorization: 'Bearer USER-BEARER-tok' },
    context: { identity: { orgId: 'ORG-1', userId: 'user-9' }, log: jest.fn(), requestId: 'req-1' },
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.write = jest.fn().mockReturnValue(true);
  res.end = jest.fn().mockReturnValue(res);
  res.on = jest.fn().mockReturnValue(res);
  res.writableFinished = false;
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServiceAuthHeader.mockReturnValue(SERVICE_TOKEN);
  mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-09-01T00:00:00Z' } });
});

/** The provider responds with `text` (the non-stream route collects the stream). */
function answersWith({ text, sources }: { text: string; sources: unknown[] }) {
  mockStreamHowTo.mockReturnValue({
    sources,
    events: (async function* () { yield { type: 'provider-responded' }; yield { type: 'text', text }; })(),
  });
}

/** The provider call fails before it ever responded (bad key, 5xx, network). */
function failsBeforeProvider(err: Error) {
  mockStreamHowTo.mockReturnValue({ sources: [], events: (async function* () { throw err; })() });
}

// -- Tests --------------------------------------------------------------------

describe('GET /ask/providers', () => {
  it('returns the configured providers', async () => {
    const res = mockRes();
    await getHandler('get', '/providers')(mockReq(undefined), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockGetAvailableProviders).toHaveBeenCalled();
  });
});

describe('POST /ask', () => {
  const handler = getHandler('post', '/');

  it('reserves aiCalls with a SERVICE-minted header, not the user bearer', async () => {
    answersWith({ text: 'answer', sources: [{ id: 'deployment.md#x' }] });
    await handler(mockReq({ query: 'how do I deploy', provider: 'anthropic', model: 'claude-sonnet-5' }), mockRes());

    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'ask', orgId: 'org-1', role: 'member' });
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
    expect(mockReserveQuota).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'Bearer USER-BEARER-tok');
    expect(mockStreamHowTo).toHaveBeenCalled();
  });

  it('audits an ask.query turn with safe metadata (no raw query) on success', async () => {
    answersWith({ text: 'answer', sources: [{ id: 'deployment.md#x' }] });
    await handler(mockReq({ query: 'how do I deploy my app' }), mockRes());

    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ask.query',
        orgId: 'org-1',
        outcome: 'success',
        details: expect.objectContaining({ queryLength: 'how do I deploy my app'.length, sources: 1, streamed: false }),
      }),
      'ask',
    );
    expect(JSON.stringify(auditRecord.mock.calls[0]?.[0])).not.toContain('how do I deploy my app');
  });

  it('audits an ask.query failure when answering throws', async () => {
    failsBeforeProvider(new Error('LLM down'));
    await handler(mockReq({ query: 'anything here' }), mockRes());
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ask.query', outcome: 'failure' }),
      'ask',
    );
  });

  it('rejects an empty query without reserving quota', async () => {
    const res = mockRes();
    await handler(mockReq({ query: '   ' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockStreamHowTo).not.toHaveBeenCalled();
  });

  it('returns 429 (not 403) when the org is at its aiCalls cap', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'aiCalls', limit: 1, used: 1, remaining: 0, resetAt: '2026-09-01T00:00:00Z' } });
    const res = mockRes();
    await handler(mockReq({ query: 'hi there friend' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockStreamHowTo).not.toHaveBeenCalled();
  });

  it('keeps the slot when a failure happens AFTER the provider answered', async () => {
    answersWith({ text: 'answer', sources: [] });
    // The success audit throws after the (paid) provider round-trip completed.
    auditRecord.mockImplementationOnce(() => { throw new Error('audit sink exploded'); });
    await handler(mockReq({ query: 'how do I deploy' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('KEEPS the slot when the provider responded and THEN failed (a paid call)', async () => {
    mockStreamHowTo.mockReturnValue({
      sources: [],
      events: (async function* () { yield { type: 'provider-responded' }; yield { type: 'text', text: 'part' }; throw new Error('socket hang up'); })(),
    });
    await handler(mockReq({ query: 'how do I deploy' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('returns the collected answer text + sources', async () => {
    answersWith({ text: 'the answer', sources: [{ id: 'a.md' }] });
    const res = mockRes();
    await handler(mockReq({ query: 'how do I deploy' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { text: 'the answer', sources: [{ id: 'a.md' }] } }));
    expect(mockStreamHowTo).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: expect.any(Number) }));
  });

  it('refunds the slot when answering throws', async () => {
    failsBeforeProvider(new Error('LLM down'));
    await handler(mockReq({ query: 'how do I deploy', provider: 'anthropic', model: 'claude-sonnet-5' }), mockRes());
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN, expect.any(Function), 1, '2026-09-01T00:00:00Z',
    );
  });
});

describe('POST /ask/stream', () => {
  const handler = getHandler('post', '/stream');

  it('emits sources, then tokens, then done — and keeps the reserved slot', async () => {
    mockStreamHowTo.mockReturnValue({
      sources: [{ id: 'deployment.md#alertmanager', title: 'Alertmanager' }],
      events: (async function* () {
        yield { type: 'provider-responded' };
        yield { type: 'text', text: 'grounded ' };
        yield { type: 'text', text: 'answer' };
      })(),
    });

    const res = mockRes();
    await handler(mockReq({ query: 'wire alertmanager for incidents' }), res);

    const frames = res.write.mock.calls.map((c: any[]) => String(c[0]));
    expect(frames.some((f: string) => f.includes('"type":"sources"') && f.includes('alertmanager'))).toBe(true);
    expect(frames.some((f: string) => f.includes('"type":"token"') && f.includes('grounded'))).toBe(true);
    expect(frames.some((f: string) => f.includes('"type":"done"'))).toBe(true);
    expect(frames.some((f: string) => f.includes('[DONE]'))).toBe(true);
    // Completed stream keeps the slot (provider round-trip already incurred).
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it('refunds + reports an error when the provider fails before it responds', async () => {
    mockStreamHowTo.mockReturnValue({
      sources: [],
      events: (async function* () { throw new Error('invalid api key'); })(),
    });
    const res = mockRes();
    await handler(mockReq({ query: 'wire alertmanager for incidents' }), res);

    const frames = res.write.mock.calls.map((c: any[]) => String(c[0]));
    expect(frames.some((f: string) => f.includes('[DONE]'))).toBe(false);
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'ask.query', outcome: 'failure' }), 'ask');
  });

  it('keeps the slot when the stream fails AFTER the first token', async () => {
    mockStreamHowTo.mockReturnValue({
      sources: [],
      events: (async function* () {
        yield { type: 'provider-responded' };
        yield { type: 'text', text: 'partial' };
        throw new Error('socket hang up');
      })(),
    });
    await handler(mockReq({ query: 'wire alertmanager for incidents' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });
});
