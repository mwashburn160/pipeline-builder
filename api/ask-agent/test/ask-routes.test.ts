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

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// -- Mocks (before imports) ---------------------------------------------------

const SERVICE_TOKEN = 'Bearer service-minted-token';

const mockAnswerHowTo = jest.fn<(...a: any[]) => any>();
const mockFetchOrgAIAccess = jest.fn<(...a: any[]) => any>();
// Runs the attempt; when `failOverOnce` is set, first reports a failover (as the
// real helper does before retrying on the next platform provider).
let failOverOnce = false;
const mockStreamHowTo = jest.fn<(...a: any[]) => any>();
const mockGetAvailableProviders = jest.fn<(...a: any[]) => any>(() => [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] }]);

jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  resolveOrgModelSelection: jest.fn(async () => ({ model: { id: 'model' }, provider: 'anthropic', modelId: 'claude-sonnet-5-5', keySource: 'platform' })),
  resolveModelSelection: jest.fn(() => ({ model: { id: 'model' }, provider: 'anthropic', modelId: 'claude-sonnet-5-5', keySource: 'platform' })),
  // Per-call helpers, reduced to pass-throughs (their behaviour is ai-core's suite).
  aiCallSettings: (o: { signal?: AbortSignal; maxOutputTokens?: number }) => ({ abortSignal: o.signal, maxOutputTokens: o.maxOutputTokens, maxRetries: 2 }),
  runWithFailover: async (sel: unknown, attempt: (s: unknown) => Promise<unknown>, opts?: { onFailover?: (f: string, t: string, e: unknown) => void }) => {
    if (failOverOnce) opts?.onFailover?.('anthropic', 'openai', new Error('529'));
    return { value: await attempt(sel), selection: sel, failedOver: [] };
  },
  aiUsageAuditDetails: (sel: { provider: string; modelId: string; keySource: string }, extra: { quotaSlot?: string; promptVersion?: string }) => ({ provider: sel.provider, model: sel.modelId, keySource: sel.keySource, quotaSlot: extra.quotaSlot, promptVersion: extra.promptVersion }),
  tokenUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
  cachedSystemPrompt: (prompt: string) => ({ role: 'system', content: prompt }),
  ASK_HOWTO_PROMPT_VERSION: 'ask-howto@test',
  answerHowTo: mockAnswerHowTo,
  streamHowTo: mockStreamHowTo,
  getAvailableProviders: mockGetAvailableProviders,
  getProviderModels: jest.fn(() => [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }]),
}));

const mockGetServiceAuthHeader = jest.fn<(...a: any[]) => string>(() => SERVICE_TOKEN);
const mockReserveQuota = jest.fn<(...a: any[]) => any>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'aiCalls', limit: 100, used: 1, remaining: 99, resetAt: '2026-09-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (event: unknown) => auditRecord(event, 'ask-agent'),
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
  requireOrgAIEnabled: (_req: unknown, _res: unknown, next: () => void) => next(),
  fetchOrgAIAccess: (...a: unknown[]) => mockFetchOrgAIAccess(...a),
  initSSEStream: jest.fn((_req: unknown, res: { write: (s: string) => unknown }) => ({
    signal: new AbortController().signal,
    aborted: () => false,
    send: (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); },
    done: (e?: unknown) => { if (e !== undefined) res.write(`data: ${JSON.stringify(e)}\n\n`); res.write('data: [DONE]\n\n'); },
  })),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaReserveDenied: jest.fn((res: any, _t: string, r: { unavailable?: boolean }) => res.status(r.unavailable ? 503 : 429).json({ message: r.unavailable ? 'quota unavailable' : 'quota exceeded' })),
  sendSuccess: jest.fn((res: any, code: number, data?: any) => res.status(code).json({ success: true, data })),
  handleAIError: jest.fn((res: any, err: unknown) => res.status(502).json({ message: err instanceof Error ? err.message : String(err) })),
}));

/** The docs index — read AFTER the reservation and BEFORE the send, so its failure is the pre-send case. */
const mockGetDocsIndex = jest.fn<AnyFn>(async () => ({ search: () => [], size: 3 }));
jest.unstable_mockModule('../src/services/docs-index.js', () => ({
  getDocsIndex: (...a: unknown[]) => mockGetDocsIndex(...a),
}));

const auditRecord = jest.fn();

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithAiCallReservation: (...a: any[]) => unknown;
let realReserveAiCallSlot: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withAiCallReservation: (...a: any[]) => realWithAiCallReservation(...a),
  reserveAiCallSlot: (...a: any[]) => realReserveAiCallSlot(...a),
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

/** The live self-hosted-model probe (its own behaviour is model-probe.test.ts). */
const mockProbe = jest.fn<(...a: any[]) => any>(async () => ({ reachable: true }));
jest.unstable_mockModule('../src/services/model-probe.js', () => ({
  probeSelfHostedModel: (...a: unknown[]) => mockProbe(...a),
  resetModelProbeCache: jest.fn(),
}));

({ withAiCallReservation: realWithAiCallReservation, reserveAiCallSlot: realReserveAiCallSlot } = await import('@pipeline-builder/api-server/lib/api/ai-call-reservation.js'));
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
  failOverOnce = false;
  mockFetchOrgAIAccess.mockResolvedValue({ aiEnabled: true, providers: [] });
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
/** The request was sent, and the provider failed before it produced anything. */
function failsBeforeProvider(err: Error) {
  mockStreamHowTo.mockReturnValue({ sources: [], events: (async function* () { throw err; })() });
}

/** The turn fails BEFORE the request is sent (the docs index read after the reservation). */
function failsBeforeSend(err: Error) {
  mockGetDocsIndex.mockRejectedValueOnce(err);
}

// -- Tests --------------------------------------------------------------------

describe('GET /ask-agent/providers', () => {
  it('returns the configured providers', async () => {
    const res = mockRes();
    await getHandler('get', '/providers')(mockReq(undefined), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockGetAvailableProviders).toHaveBeenCalled();
  });
});

describe('GET /ask-agent/availability', () => {
  const availability = async () => {
    const res = mockRes();
    await getHandler('get', '/availability')(mockReq(undefined), res);
    return res.json.mock.calls[0]?.[0]?.data;
  };

  it('says the assistant is off when the org switched AI off', async () => {
    mockFetchOrgAIAccess.mockResolvedValue({ aiEnabled: false, providers: [] });
    expect(await availability()).toMatchObject({ available: false, reason: 'disabled' });
  });

  it('predicts from the org\'s own provider, else the platform default, without reading a key', async () => {
    mockFetchOrgAIAccess.mockResolvedValue({ aiEnabled: true, providers: ['openai'] });
    expect(await availability()).toEqual({ available: true });
    mockFetchOrgAIAccess.mockResolvedValue({ aiEnabled: true, providers: [] });
    expect(await availability()).toEqual({ available: true });
  });

  it('falls back to the platform-default prediction when the org settings cannot be read', async () => {
    mockFetchOrgAIAccess.mockRejectedValue(new Error('platform down'));
    expect(await availability()).toEqual({ available: true });
  });
  describe('?probe=true', () => {
    const localProvider = { id: 'openai-compatible', name: 'Local model', models: [{ id: 'qwen', name: 'Qwen' }] };
    const probed = async (query: Record<string, string>) => {
      const res = mockRes();
      await getHandler('get', '/availability')({ ...mockReq(undefined), query }, res);
      return res.json.mock.calls[0]?.[0]?.data;
    };

    beforeEach(() => {
      mockProbe.mockReset();
      mockFetchOrgAIAccess.mockResolvedValue({ aiEnabled: true, providers: [] });
      mockGetAvailableProviders.mockReturnValue([localProvider]);
    });

    // clearAllMocks keeps implementations: restore the suite's default list.
    afterEach(() => {
      mockGetAvailableProviders.mockReturnValue([{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] }]);
    });

    it('reports the self-hosted model unreachable when the live probe fails', async () => {
      mockProbe.mockResolvedValue({ reachable: false });
      expect(await probed({ probe: 'true', provider: 'openai-compatible' })).toMatchObject({ available: false, reason: 'unreachable' });
      expect(mockProbe).toHaveBeenCalledTimes(1);
    });

    it('reports available when the live probe succeeds', async () => {
      mockProbe.mockResolvedValue({ reachable: true });
      expect(await probed({ probe: 'true', provider: 'openai-compatible' })).toEqual({ available: true });
    });

    it('never probes without ?probe=true — the Ask panel check stays socket-free', async () => {
      expect(await probed({ provider: 'openai-compatible' })).toEqual({ available: true });
      expect(mockProbe).not.toHaveBeenCalled();
    });

    it('never probes a cloud provider', async () => {
      mockGetAvailableProviders.mockReturnValue([{ id: 'anthropic', name: 'Anthropic', models: [] }, localProvider]);
      expect(await probed({ probe: 'true', provider: 'anthropic' })).toEqual({ available: true });
      expect(mockProbe).not.toHaveBeenCalled();
    });

    it('ignores a provider id that is not configured', async () => {
      // Falls back to the predicted default (anthropic in this suite's resolveModelSelection mock).
      expect(await probed({ probe: 'true', provider: 'made-up' })).toEqual({ available: true });
      expect(mockProbe).not.toHaveBeenCalled();
    });
  });
});

describe('failover is logged', () => {
  it('records a failover on both routes', async () => {
    failOverOnce = true;
    answersWith({ text: 'answer', sources: [] });
    const req = mockReq({ query: 'how do I deploy my app' });
    await getHandler('post', '/')(req, mockRes());
    expect(req.context.log).toHaveBeenCalledWith('WARN', 'Ask how-to failed over', { from: 'anthropic', to: 'openai' });
    answersWith({ text: 'answer', sources: [] });
    const sreq = mockReq({ query: 'how do I deploy my app' });
    await getHandler('post', '/stream')(sreq, mockRes());
    expect(sreq.context.log).toHaveBeenCalledWith('WARN', 'Ask how-to stream failed over', { from: 'anthropic', to: 'openai' });
  });
});

describe('POST /ask-agent', () => {
  const handler = getHandler('post', '/');

  it('reserves aiCalls with a SERVICE-minted header, not the user bearer', async () => {
    answersWith({ text: 'answer', sources: [{ id: 'deployment.md#x' }] });
    await handler(mockReq({ query: 'how do I deploy', provider: 'anthropic', model: 'claude-sonnet-5' }), mockRes());

    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'ask-agent', orgId: 'org-1', role: 'member' });
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN, 1, expect.objectContaining({ keySource: 'platform' }));
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
      'ask-agent',
    );
    expect(JSON.stringify(auditRecord.mock.calls[0]?.[0])).not.toContain('how do I deploy my app');
  });

  it('records the RESOLVED provider/model and the kept aiCalls slot on the audit row', async () => {
    answersWith({ text: 'answer', sources: [] });
    await handler(mockReq({ query: 'how do I deploy my app' }), mockRes());
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          // The shared AI usage block: who answered, whose key, the prompt version.
          ai: expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-5-5', keySource: 'platform', quotaSlot: 'kept', promptVersion: 'ask-howto@test' }),
          quota: { type: 'aiCalls', slot: 'kept', amount: 1, used: 1, limit: 100 },
        }),
      }),
      'ask-agent',
    );
  });

  it('records a REFUNDED slot when the turn failed before the request was sent', async () => {
    failsBeforeSend(new Error('docs index unavailable'));
    await handler(mockReq({ query: 'anything here' }), mockRes());
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', details: expect.objectContaining({ quota: expect.objectContaining({ slot: 'refunded' }) }) }),
      'ask-agent',
    );
  });

  it('audits an ask.query failure when answering throws', async () => {
    failsBeforeProvider(new Error('LLM down'));
    await handler(mockReq({ query: 'anything here' }), mockRes());
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ask.query', outcome: 'failure' }),
      'ask-agent',
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

  it('refunds the slot when the turn fails before the send', async () => {
    failsBeforeSend(new Error('docs index unavailable'));
    await handler(mockReq({ query: 'how do I deploy', provider: 'anthropic', model: 'claude-sonnet-5' }), mockRes());
    expect(mockStreamHowTo).not.toHaveBeenCalled();
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN, expect.any(Function), 1, '2026-09-01T00:00:00Z',
      expect.objectContaining({ feature: 'ask', model: 'claude-sonnet-5-5', keySource: 'platform' }),
    );
  });

  it('KEEPS the slot when the provider fails after the send, before it responds', async () => {
    failsBeforeProvider(new Error('LLM down'));
    await handler(mockReq({ query: 'how do I deploy' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', details: expect.objectContaining({ quota: expect.objectContaining({ slot: 'kept' }) }) }),
      'ask-agent',
    );
  });

  it.each([
    ['ABORTED', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['TIMED OUT', Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })],
  ])('KEEPS the slot when the call is %s after the send', async (_label, error) => {
    failsBeforeProvider(error);
    await handler(mockReq({ query: 'how do I deploy' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });
});

describe('POST /ask-agent/stream', () => {
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

  it('keeps the slot + reports an error when the provider fails after the send, before it responds', async () => {
    mockStreamHowTo.mockReturnValue({
      sources: [],
      events: (async function* () { throw new Error('invalid api key'); })(),
    });
    const res = mockRes();
    await handler(mockReq({ query: 'wire alertmanager for incidents' }), res);

    const frames = res.write.mock.calls.map((c: any[]) => String(c[0]));
    expect(frames.some((f: string) => f.includes('[DONE]'))).toBe(false);
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ action: 'ask.query', outcome: 'failure' }), 'ask-agent');
  });

  it('refunds when the stream turn fails BEFORE the send', async () => {
    failsBeforeSend(new Error('docs index unavailable'));
    await handler(mockReq({ query: 'wire alertmanager for incidents' }), mockRes());
    expect(mockStreamHowTo).not.toHaveBeenCalled();
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });

  it('keeps the slot when the stream call TIMES OUT after the send', async () => {
    failsBeforeProvider(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
    await handler(mockReq({ query: 'wire alertmanager for incidents' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
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

// -- BYOK / impersonation: no aiCalls unit ------------------------------------

describe('POST /ask-agent — a call that spends no aiCalls unit', () => {
  const handler = getHandler('post', '/');
  const usageReport = jest.fn<(...a: any[]) => Promise<void>>(async () => undefined);
  const resolveSel = async () => (await import('@pipeline-builder/ai-core')).resolveOrgModelSelection as unknown as jest.Mock<(...a: any[]) => any>;

  beforeEach(() => { mockQuotaService.reportUsage = usageReport; usageReport.mockClear(); });

  it.each(['org', 'request'])('a BYOK (%s key) turn reserves nothing, audits the slot as waived, and is still reported', async (keySource) => {
    (await resolveSel()).mockResolvedValueOnce({ model: { id: 'model' }, provider: 'anthropic', modelId: 'claude-sonnet-5-5', keySource });
    answersWith({ text: 'answer', sources: [] });
    await handler(mockReq({ query: 'how do I deploy my app' }), mockRes());
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ quota: { type: 'aiCalls', slot: 'waived', waived: 'byok', amount: 0 } }) }),
      'ask-agent',
    );
    expect(usageReport).toHaveBeenCalledWith('org-1', 'aiCalls', SERVICE_TOKEN, expect.any(Object), expect.objectContaining({ feature: 'ask', keySource }));
  });

  it('an impersonation session reserves nothing (the turn is still audited)', async () => {
    answersWith({ text: 'answer', sources: [] });
    await handler({ ...mockReq({ query: 'how do I deploy my app' }), user: { sub: 'user-9', impersonatorId: 'staff-1' } }, mockRes());
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ quota: expect.objectContaining({ slot: 'waived', waived: 'impersonation' }) }) }),
      'ask-agent',
    );
  });

  it('caps the TOTAL history a turn may resend', async () => {
    const res = mockRes();
    const history = Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(7_000) }));
    await handler(mockReq({ query: 'q', history }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });
});
