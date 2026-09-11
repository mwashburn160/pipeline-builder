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

// fullStream parts the mocked streamText will emit.
let streamParts: Array<Record<string, unknown>> = [];
const streamText = jest.fn(() => ({
  fullStream: (async function* () { for (const p of streamParts) yield p; })(),
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
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  initSSEStream: jest.fn(() => ({ aborted: () => false })),
  sendBadRequest: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaExceeded: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }) => res.status(429).json({ message: 'quota exceeded' })),
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
  return { body, on: jest.fn(), headers: { authorization: auth }, context: { identity: { orgId: 'ORG-1', userId: 'u9' }, log: jest.fn(), requestId: 'r1' } };
}
function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.write = jest.fn().mockReturnValue(true);
  res.end = jest.fn().mockReturnValue(res);
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
    streamParts = [{ type: 'text-delta', text: 'hi' }];
    await handler(mockReq({ query: 'help me' }), mockRes());

    expect(pipelineClient).toHaveBeenCalledWith('Bearer USER-tok');
    expect(buildAgentTools).toHaveBeenCalled();
    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'ask', orgId: 'org-1', role: 'member' });
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
  });

  it('rejects a request with no Authorization header (no quota reserved)', async () => {
    const res = mockRes();
    const req = { body: { query: 'help me' }, on: jest.fn(), headers: {}, context: { identity: { orgId: 'ORG-1', userId: 'u9' }, log: jest.fn(), requestId: 'r1' } };
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });

  it('maps fullStream to SSE (tool-call, proposal, token, done) and keeps the slot', async () => {
    streamParts = [
      { type: 'tool-call', toolName: 'propose_pipeline' },
      { type: 'tool-result', toolName: 'propose_pipeline', output: { kind: 'pipeline', props: { name: 'x' } } },
      { type: 'tool-result', toolName: 'answer_how_to', output: { context: 'noise', sources: [{ id: 'deployment.md#x' }] } },
      { type: 'tool-result', toolName: 'list_pipelines', output: { pipelines: [] } },
      { type: 'text-delta', text: 'Here is a draft.' },
    ];
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
    streamParts = [{ type: 'error', error: new Error('model exploded') }];
    await handler(mockReq({ query: 'do something' }), mockRes());
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ask.agent.turn', outcome: 'failure' }),
      'ask',
    );
  });
});
