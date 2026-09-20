// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-disconnect handling over a REAL HTTP server (express.json() body parsing
 * + a real socket). The streaming routes used `req.on('close')` to abort the
 * provider call; on Node >= 16 the request emits 'close' as soon as its body has
 * been consumed — before the handler attaches the listener — so a mid-stream
 * disconnect never aborted anything (wasted provider spend, writes to a dead
 * socket, a "successful" turn). The routes now observe `res` 'close' and only
 * abort when the response had not finished.
 *
 * Only the provider (ai-core) and the api-core/api-server edges are stubbed; the
 * abort wiring, express, and the HTTP transport are real.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeEach, afterAll, beforeAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

let seenSignal: AbortSignal | undefined;

/** Resolves when `signal` aborts, or after `ms` (whichever first). */
function abortedOrTimeout(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Stream mode: 'hang' waits for the client to disconnect; 'complete' finishes.
let mode: 'hang' | 'complete' = 'complete';

const streamText = jest.fn((opts: { abortSignal?: AbortSignal }) => {
  seenSignal = opts.abortSignal;
  return {
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    fullStream: (async function* () {
      yield { type: 'start' };
      yield { type: 'start-step', request: {}, warnings: [] };
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', text: 'partial' };
      if (mode === 'hang') {
        await abortedOrTimeout(opts.abortSignal, 3000);
        yield { type: 'abort' };
        return;
      }
      yield { type: 'text-end', id: 't1' };
      yield { type: 'finish-step', finishReason: 'stop', usage: {} };
      yield { type: 'finish', finishReason: 'stop', totalUsage: {} };
    })(),
  };
});
const streamHowTo = jest.fn((opts: { abortSignal?: AbortSignal }) => {
  seenSignal = opts.abortSignal;
  return {
    sources: [{ id: 'deployment.md#x' }],
    events: (async function* () {
      yield { type: 'provider-responded' };
      yield { type: 'text', text: 'partial' };
      if (mode === 'hang') {
        await abortedOrTimeout(opts.abortSignal, 3000);
        return;
      }
      yield { type: 'text', text: ' answer' };
    })(),
  };
});
jest.unstable_mockModule('@pipeline-builder/ai-core', () => ({
  streamText,
  streamHowTo,
  stepCountIs: (n: number) => n,
  answerHowTo: jest.fn(),
  getAvailableProviders: jest.fn(() => []),
}));

const mockDecrementQuota = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  getServiceAuthHeader: jest.fn(() => 'Bearer service'),
  reserveQuota: jest.fn(async () => ({ exceeded: false, quota: { type: 'aiCalls', resetAt: '2026-09-01T00:00:00Z' } })),
  decrementQuota: mockDecrementQuota,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  // Route-table gate declarations on the ask routes (the real behaviour is
  // covered by the route-coverage test + api-core's own gate tests).
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  initSSEStream: (_req: unknown, res: http.ServerResponse) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    return { aborted: () => false };
  },
  sendBadRequest: jest.fn(),
  sendQuotaReserveDenied: jest.fn(),
  sendSuccess: jest.fn(),
  handleAIError: jest.fn((res: http.ServerResponse) => res.end()),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: req.context, orgId: 'org-1', userId: 'u1' });
    req.context.done();
  },
  incCounter: jest.fn(),
  observe: jest.fn(),
  withSpan: (_n: string, fn: (span: unknown) => Promise<unknown>) => fn({ addEvent: jest.fn() }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({ CoreConstants: { SSE_STREAM_TIMEOUT_MS: 300000 } }));
jest.unstable_mockModule('../src/services/docs-index.js', () => ({ getDocsIndex: jest.fn(async () => ({ search: () => [], size: 1 })) }));
jest.unstable_mockModule('../src/services/model.js', () => ({ resolveAskModel: jest.fn(() => ({ id: 'model' })) }));
jest.unstable_mockModule('../src/services/agent-tools.js', () => ({ buildAgentTools: jest.fn(() => ({})) }));
jest.unstable_mockModule('../src/services/internal-http.js', () => ({ pipelineClient: jest.fn(), pluginClient: jest.fn() }));
const auditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({ getAuditClient: () => ({ record: auditRecord }) }));

const express = (await import('express')).default;
const { createAskRoutes } = await import('../src/routes/ask.js');
const { createAgentRoutes } = await import('../src/routes/agent.js');

let handlerDone: Promise<void>;
let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    let resolve!: () => void;
    handlerDone = new Promise<void>((r) => { resolve = r; });
    req.context = { log: jest.fn(), requestId: 'r1', identity: { orgId: 'org-1' }, done: resolve };
    next();
  });
  app.use('/ask', createAskRoutes({} as never), createAgentRoutes({} as never));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  jest.clearAllMocks();
  seenSignal = undefined;
});

/** POST a JSON body; `disconnectOnFirstChunk` destroys the socket once streaming starts. */
function post(path: string, disconnectOnFirstChunk: boolean): Promise<string> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ query: 'how do I deploy' });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer USER' },
    }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => {
        text += c.toString();
        if (disconnectOnFirstChunk && text.includes('partial')) { req.destroy(); resolve(text); }
      });
      res.on('end', () => resolve(text));
    });
    req.on('error', () => resolve(''));
    req.end(body);
  });
}

describe.each([
  ['/ask/agent/stream'],
  ['/ask/stream'],
])('%s client disconnect', (path) => {
  it('aborts the provider call when the client disconnects mid-stream (and keeps the paid slot)', async () => {
    mode = 'hang';
    await post(path, true);
    await handlerDone;

    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(true);
    // The provider had already responded ('start-step' / first token) — keep the slot.
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }), 'ask');
  });

  it('does NOT abort on a normal completion', async () => {
    mode = 'complete';
    const text = await post(path, false);
    await handlerDone;
    // Let the response 'close' event (which follows 'finish') fire.
    await new Promise((r) => setImmediate(r));

    expect(text).toContain('[DONE]');
    expect(seenSignal!.aborted).toBe(false);
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }), 'ask');
  });
});
