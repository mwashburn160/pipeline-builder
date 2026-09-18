// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/agent (the tool-calling "Ask" agent). Focus: forwards the USER
 * token to the tools, reserves one aiCalls with a SERVICE header, maps the model's
 * fullStream to SSE (token / tool-call / proposal / done), and keeps the slot on a
 * completed turn.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const SERVICE_TOKEN = 'Bearer service-minted-token';

// fullStream parts the mocked streamText will emit. Shaped like ai@7's real
// fullStream: 'start' is emitted synchronously BEFORE any provider call;
// 'start-step' only once the provider's response stream yields its first chunk;
// a provider failure before that is a bare 'error' part (no 'start-step').
let streamParts: Array<Record<string, unknown>> = [];

/** A realistic single-step turn wrapping `inner` parts in start/step/finish framing. */
function turn(...inner: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [
    { type: 'start' },
    { type: 'start-step', request: {}, warnings: [] },
    ...inner,
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
  ];
}
/** Text output as the SDK emits it: text-start / text-delta / text-end. */
function text(t: string, id = 't1'): Array<Record<string, unknown>> {
  return [{ type: 'text-start', id }, { type: 'text-delta', id, text: t }, { type: 'text-end', id }];
}
const streamText = jest.fn(() => ({
  fullStream: (async function* () { for (const p of streamParts) yield p; })(),
  usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
}));
const stepCountIs = jest.fn((n: number) => n);
jest.unstable_mockModule('@pipeline-builder/ai-core', () => ({ streamText, stepCountIs }));

const mockGetServiceAuthHeader = jest.fn<(...a: unknown[]) => string>(() => SERVICE_TOKEN);
const mockReserveQuota = jest.fn<(...a: unknown[]) => unknown>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'aiCalls', resetAt: '2026-09-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
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
  sendBadRequest: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaReserveDenied: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, _t: string, r: { unavailable?: boolean }) => res.status(r.unavailable ? 503 : 429).json({ message: r.unavailable ? 'quota unavailable' : 'quota exceeded' })),
  handleAIError: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, m: string) => res.status(502).json({ message: m })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: { context: { identity: { orgId?: string; userId?: string } } }, res: unknown) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    if (!orgId) return (res as { status: (n: number) => { json: (b: unknown) => unknown } }).status(400).json({ message: 'org required' });
    await handler({ req, res, ctx, orgId, userId: ctx.identity.userId || '' });
  },
  incCounter: jest.fn(),
  observe: jest.fn(),
  withSpan: (_name: string, fn: (span: unknown) => Promise<unknown>) => fn({ addEvent: jest.fn(), setAttributes: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({ CoreConstants: { SSE_STREAM_TIMEOUT_MS: 300000 } }));
jest.unstable_mockModule('../src/services/docs-index.js', () => ({ getDocsIndex: jest.fn(async () => ({ search: () => [], size: 1 })) }));
jest.unstable_mockModule('../src/services/model.js', () => ({ resolveAskModel: jest.fn(() => ({ id: 'model' })) }));
const buildAgentTools = jest.fn(() => ({}));
jest.unstable_mockModule('../src/services/agent-tools.js', () => ({ buildAgentTools }));
const pipelineClient = jest.fn(() => ({ get: jest.fn(), post: jest.fn() }));
const pluginClient = jest.fn(() => ({ get: jest.fn(), post: jest.fn() }));
jest.unstable_mockModule('../src/services/internal-http.js', () => ({ pipelineClient, pluginClient }));
const auditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({ getAuditClient: () => ({ record: auditRecord }) }));

const { createAgentRoutes } = await import('../src/routes/agent.js');

const mockQuotaService = {} as never;
const router = createAgentRoutes(mockQuotaService);

function getHandler(method: string, path: string) {
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack
    .find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`no handler ${method} ${path}`);
  const s = layer.route!.stack;
  return s[s.length - 1].handle;
}
function mockReq(body: unknown, auth = 'Bearer USER-tok'): any {
  return { body, headers: { authorization: auth }, context: { identity: { orgId: 'ORG-1', userId: 'u9' }, log: jest.fn(), requestId: 'r1' } };
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

const handler = getHandler('post', '/agent/stream');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetServiceAuthHeader.mockReturnValue(SERVICE_TOKEN);
  mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { type: 'aiCalls', resetAt: '2026-09-01T00:00:00Z' } });
  streamParts = [];
});

describe('POST /ask/agent/stream', () => {
  it('forwards the USER token to the tools and reserves quota with a SERVICE header', async () => {
    streamParts = turn(...text('hi'));
    await handler(mockReq({ query: 'help me' }), mockRes());

    expect(pipelineClient).toHaveBeenCalledWith('Bearer USER-tok');
    expect(buildAgentTools).toHaveBeenCalled();
    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'ask', orgId: 'org-1', role: 'member' });
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
  });

  it('rejects a request with no Authorization header (no quota reserved)', async () => {
    const res = mockRes();
    const req = { body: { query: 'help me' }, headers: {}, context: { identity: { orgId: 'ORG-1', userId: 'u9' }, log: jest.fn(), requestId: 'r1' } };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });

  it('maps fullStream to SSE (tool-call, proposal, token, done) and keeps the slot', async () => {
    streamParts = turn(
      { type: 'tool-call', toolCallId: 'c1', toolName: 'propose_pipeline', input: {} },
      { type: 'tool-result', toolCallId: 'c1', toolName: 'propose_pipeline', input: {}, output: { kind: 'pipeline', props: { name: 'x' } } },
      { type: 'tool-result', toolCallId: 'c2', toolName: 'answer_how_to', input: {}, output: { context: 'noise', sources: [{ id: 'deployment.md#x' }] } },
      { type: 'tool-result', toolCallId: 'c3', toolName: 'list_pipelines', input: {}, output: { pipelines: [] } },
      ...text('Here is a draft.'),
    );
    const res = mockRes();
    await handler(mockReq({ query: 'create a pipeline' }), res);

    const frames = res.write.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(frames.some((f: string) => f.includes('"type":"tool-call"') && f.includes('propose_pipeline'))).toBe(true);
    expect(frames.some((f: string) => f.includes('"type":"proposal"') && f.includes('"name":"x"'))).toBe(true);
    // answer_how_to surfaces its grounded sources
    expect(frames.some((f: string) => f.includes('"type":"sources"') && f.includes('deployment.md#x'))).toBe(true);
    // list_pipelines feeds the model but is not surfaced to the UI
    expect(frames.some((f: string) => f.includes('"pipelines"'))).toBe(false);
    expect(frames.some((f: string) => f.includes('"type":"token"') && f.includes('draft'))).toBe(true);
    expect(frames.some((f: string) => f.includes('[DONE]'))).toBe(true);
    expect(mockDecrementQuota).not.toHaveBeenCalled();

    // Audits the turn with SAFE METADATA ONLY — tools + proposal kinds, never the query.
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ask.agent.turn',
        orgId: 'org-1',
        outcome: 'success',
        details: expect.objectContaining({ toolsCalled: ['propose_pipeline'], proposals: ['pipeline'] }),
      }),
      'ask',
    );
    const audited = JSON.stringify(auditRecord.mock.calls[0]?.[0]);
    expect(audited).not.toContain('create a pipeline'); // raw query text never audited
  });

  it('audits an ask.agent.turn failure when the stream throws', async () => {
    streamParts = turn({ type: 'error', error: new Error('model exploded') });
    await handler(mockReq({ query: 'do something' }), mockRes());
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ask.agent.turn', outcome: 'failure' }),
      'ask',
    );
  });
});

describe('POST /ask/agent/stream — aiCalls refund boundary', () => {
  /**
   * The refund must hinge on whether the PROVIDER was actually reached, not
   * merely on whether we reserved. The old code refunded unconditionally,
   * including for the `case 'error'` raised from INSIDE `fullStream` — i.e.
   * strictly after the model round-trip — so a client that provoked mid-stream
   * provider errors burned tokens without ever consuming quota.
   *
   * "Reached" means the SDK emitted 'start-step' (first chunk of the provider's
   * response). The SDK's own 'start' part precedes any provider call, so keying
   * on "any part" never refunded a provider failure.
   */
  it('REFUNDS when the failure happens BEFORE the provider responds', async () => {
    // streamText itself throws → nothing ever streamed → we owe nothing.
    streamText.mockImplementationOnce(() => { throw new Error('model config invalid'); });
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });

  it('REFUNDS when the provider call fails before it responds (start → error, no start-step)', async () => {
    // How ai@7 surfaces a failed doStream (bad key / 5xx / network): its own
    // 'start' part, then a bare 'error' — the provider never produced a chunk.
    streamParts = [{ type: 'start' }, { type: 'error', error: new Error('401 invalid x-api-key') }];
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });

  it('does NOT refund when the stream errors AFTER the provider responded', async () => {
    // A token flowed (provider billed us), then the model emitted an error part.
    streamParts = [
      { type: 'start' },
      { type: 'start-step', request: {}, warnings: [] },
      ...text('partial'),
      { type: 'error', error: new Error('provider blew up mid-stream') },
    ];
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('does NOT refund when an error is the FIRST thing the provider streams', async () => {
    // The provider responded (start-step) and its first chunk was an error event.
    streamParts = [{ type: 'start' }, { type: 'start-step', request: {}, warnings: [] }, { type: 'error', error: new Error('content filter') }];
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('keeps the slot on a completed turn', async () => {
    streamParts = turn(...text('done'));
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('bounds the tool-calling loop so a looping agent cannot burn the budget', async () => {
    streamParts = turn(...text('hi'));
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(stepCountIs).toHaveBeenCalledWith(6);
  });
});
