// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/agent (the tool-calling "Ask" agent). Focus: forwards the USER
 * token to the tools, reserves one aiCalls with a SERVICE header, maps the model's
 * fullStream to SSE (token / tool-call / proposal / done), and keeps the slot on a
 * completed turn.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

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
const streamText = jest.fn((..._args: unknown[]) => ({
  fullStream: (async function* () { for (const p of streamParts) yield p; })(),
  usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
}));
const stepCountIs = jest.fn((n: number) => n);
jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  resolveModelSelection: jest.fn(() => ({ model: { id: 'model' }, provider: 'anthropic', modelId: 'claude-sonnet-5' })),
  streamText,
  stepCountIs,
}));

const mockIncCounter = jest.fn<AnyFn>();
const mockGetServiceAuthHeader = jest.fn<(...a: unknown[]) => string>(() => SERVICE_TOKEN);
const mockReserveQuota = jest.fn<AnyFn>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'aiCalls', resetAt: '2026-09-01T00:00:00Z' } }));
const mockDecrementQuota = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (event: unknown) => auditRecord(event, 'ask'),
  createLogger: () => ({ info: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), debug: jest.fn<AnyFn>() }),
  getServiceAuthHeader: mockGetServiceAuthHeader,
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  // Route-table gate declarations on the ask routes (the real behaviour is
  // covered by the route-coverage test + api-core's own gate tests).
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  initSSEStream: jest.fn((_req: unknown, res: { write: (s: string) => unknown }) => ({
    signal: new AbortController().signal,
    aborted: () => false,
    send: (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); },
    done: (e?: unknown) => { if (e !== undefined) res.write(`data: ${JSON.stringify(e)}\n\n`); res.write('data: [DONE]\n\n'); },
  })),
  sendBadRequest: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, msg: string) => res.status(400).json({ message: msg })),
  sendQuotaReserveDenied: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, _t: string, r: { unavailable?: boolean }) => res.status(r.unavailable ? 503 : 429).json({ message: r.unavailable ? 'quota unavailable' : 'quota exceeded' })),
  handleAIError: jest.fn((res: { status: (n: number) => { json: (b: unknown) => unknown } }, m: string) => res.status(502).json({ message: m })),
}));

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithQuotaReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withQuotaReservation: (...a: any[]) => realWithQuotaReservation(...a),
  withRoute: (handler: Function) => async (req: { context: { identity: { orgId?: string; userId?: string } } }, res: unknown) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    if (!orgId) { (res as { status: (n: number) => { json: (b: unknown) => unknown } }).status(400).json({ message: 'org required' }); return; }
    await handler({ req, res, ctx, orgId, userId: ctx.identity.userId || '' });
  },
  incCounter: mockIncCounter,
  observe: jest.fn<AnyFn>(),
  withSpan: (_name: string, fn: (span: unknown) => Promise<unknown>) => fn({ addEvent: jest.fn<AnyFn>(), setAttributes: jest.fn<AnyFn>() }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', { CoreConstants: { SSE_STREAM_TIMEOUT_MS: 300000 } }));
jest.unstable_mockModule('../src/services/docs-index.js', () => ({ getDocsIndex: jest.fn(async () => ({ search: () => [], size: 1 })) }));
jest.unstable_mockModule('../src/services/model.js', () => ({ ASK_MAX_OUTPUT_TOKENS: 2048 }));
const buildAgentTools = jest.fn(() => ({}));
jest.unstable_mockModule('../src/services/agent-tools.js', () => ({ buildAgentTools }));
const stubClient = () => ({ get: jest.fn<AnyFn>(), post: jest.fn<AnyFn>() });
const pipelineClient = jest.fn((..._args: unknown[]) => stubClient());
const pluginClient = jest.fn((..._args: unknown[]) => stubClient());
const platformClient = jest.fn((..._args: unknown[]) => stubClient());
const complianceClient = jest.fn((..._args: unknown[]) => stubClient());
const reportingClient = jest.fn((..._args: unknown[]) => stubClient());
const quotaClient = jest.fn((..._args: unknown[]) => stubClient());
jest.unstable_mockModule('../src/services/internal-http.js', () => ({
  pipelineClient, pluginClient, platformClient, complianceClient, reportingClient, quotaClient,
}));
const auditRecord = jest.fn<AnyFn>();

({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
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
  return { body, headers: { authorization: auth }, context: { identity: { orgId: 'ORG-1', userId: 'u9' }, log: jest.fn<AnyFn>(), requestId: 'r1' } };
}
function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  res.write = jest.fn<AnyFn>().mockReturnValue(true);
  res.end = jest.fn<AnyFn>().mockReturnValue(res);
  res.on = jest.fn<AnyFn>().mockReturnValue(res);
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
    // EVERY service client the tools use is bound to the CALLER's bearer — the
    // agent never acts as a service principal against any of them.
    for (const client of [pluginClient, platformClient, complianceClient, reportingClient, quotaClient]) {
      expect(client).toHaveBeenCalledWith('Bearer USER-tok');
    }
    expect(buildAgentTools).toHaveBeenCalled();
    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'ask', orgId: 'org-1', role: 'member' });
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
  });

  it('rejects a request with no Authorization header (no quota reserved)', async () => {
    const res = mockRes();
    const req = { body: { query: 'help me' }, headers: {}, context: { identity: { orgId: 'ORG-1', userId: 'u9' }, log: jest.fn<AnyFn>(), requestId: 'r1' } };
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

  it('caps every model step\'s output tokens', async () => {
    streamParts = turn(...text('hi'));
    await handler(mockReq({ query: 'help me' }), mockRes());
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 2048 }));
  });

  it('an in-process generating tool reserves its OWN aiCalls slot (not free on the turn\'s slot)', async () => {
    streamParts = turn(...text('hi'));
    await handler(mockReq({ query: 'help me' }), mockRes());
    const deps = (buildAgentTools.mock.calls[0] as unknown as [{ chargeAiCall: (t: string) => Promise<boolean>; maxOutputTokens: number }])[0];
    expect(deps.maxOutputTokens).toBe(2048);
    mockReserveQuota.mockClear();
    await expect(deps.chargeAiCall('propose_template')).resolves.toBe(true);
    expect(mockReserveQuota).toHaveBeenCalledWith(mockQuotaService, 'org-1', 'aiCalls', SERVICE_TOKEN);
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'aiCalls', resetAt: 'x' } });
    await expect(deps.chargeAiCall('propose_template')).resolves.toBe(false);
  });
});

describe('POST /ask/agent/stream — refused-field signal (design rule 10)', () => {
  it('counts, logs and AUDITS a proposal that named fields outside the allowlist', async () => {
    // A propose tool that refuses fields does so DURING the turn, so drive the
    // callback from the tool-building step the way a real tool would.
    buildAgentTools.mockImplementationOnce(((deps: { onRefusedFields: (t: string, f: string[]) => void }) => {
      deps.onRefusedFields('propose_org_settings', ['mfaRequired', 'ssoRequired']);
      return {};
    }) as never);
    streamParts = turn(...text('I cannot change that.'));
    const req = mockReq({ query: 'turn off MFA for everyone' });
    await handler(req, mockRes());

    // A dedicated counter, so an operator can alert on injection attempts.
    expect(mockIncCounter).toHaveBeenCalledWith('ask_proposal_refused_fields_total', { tool: 'propose_org_settings' }, 2);
    // A log line naming the fields.
    expect(req.context.log).toHaveBeenCalledWith(
      'WARN',
      expect.stringContaining('outside the allowlist'),
      { tool: 'propose_org_settings', fields: ['mfaRequired', 'ssoRequired'] },
    );
    // And the turn's audit event, so the attempt is reconstructable later.
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ask.agent.turn',
        details: expect.objectContaining({ refusedFields: ['mfaRequired', 'ssoRequired'] }),
      }),
      'ask',
    );
  });

  it('omits refusedFields from the audit when a turn refused nothing', async () => {
    streamParts = turn(...text('hi'));
    await handler(mockReq({ query: 'help me' }), mockRes());
    const details = (auditRecord.mock.calls[0]?.[0] as { details: Record<string, unknown> }).details;
    expect(details).not.toHaveProperty('refusedFields');
  });
});
