// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * loki-client against a REAL local HTTP server standing in for Loki — the real
 * `fetch`, URL building, tenant header, envelope handling, ns→ms conversion,
 * read-time masking, multi-stream ordering, the categorized upstream errors
 * (5xx / connection refused → `unreachable`, 4xx and a non-success envelope →
 * `upstream-4xx`), and `iterateLogs`' paging (boundary-instant dedup, the
 * `maxEntries` cap, short-page and deadline stops).
 *
 * The client itself never retries — a failed call surfaces as one categorized
 * error and the controller decides (degrade vs 500); asserted below by counting
 * requests.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.JWT_SECRET ||= 'loki-client-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

const { queryLogs, queryLogVolume, iterateLogs } = await import('../src/observability/loki-client.js');
const { maskLine } = await import('@pipeline-builder/api-core');

type Handler = (req: IncomingMessage, url: URL, res: ServerResponse) => void;
let handler: Handler;
const requests: Array<{ url: URL; tenant: string | undefined }> = [];
let server: Server;
let base: string;
const savedLoki = process.env.LOKI_URL;

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const streams = (result: unknown) => ({ status: 'success', data: { resultType: 'streams', result } });
const ns = (ms: number) => String(ms * 1e6);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://loki.local');
    requests.push({ url, tenant: req.headers['x-scope-orgid'] as string | undefined });
    handler(req, url, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedLoki === undefined) delete process.env.LOKI_URL;
  else process.env.LOKI_URL = savedLoki;
});

beforeEach(() => {
  requests.length = 0;
  process.env.LOKI_URL = base; // no trailing slash: the client adds one
  handler = (_req, _url, res) => json(res, 200, streams([]));
});

describe('queryLogs', () => {
  it('sends the query range in ns with the tenant header, and returns masked entries newest-first across streams', async () => {
    const secretLine = 'login ok Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    handler = (_req, _url, res) => json(res, 200, streams([
      { stream: { app: 'a' }, values: [[ns(1000), 'a-old'], [ns(3000), secretLine, { orgId: 'org-1' }]] },
      { stream: { app: 'b' }, values: [[ns(2000), 'b-mid']] },
    ]));

    const out = await queryLogs('{app=~".+"}', 'org-1|org-2', { startMs: 500, endMs: 4000, limit: 10 });

    expect(requests).toHaveLength(1);
    const { url, tenant } = requests[0];
    expect(url.pathname).toBe('/loki/api/v1/query_range');
    expect(tenant).toBe('org-1|org-2');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: '{app=~".+"}', start: ns(500), end: ns(4000), limit: '10', direction: 'backward',
    });
    expect(out.map((e) => e.time)).toEqual([3000, 2000, 1000]);
    // Structured metadata merges over the stream labels.
    expect(out[0].labels).toEqual({ app: 'a', orgId: 'org-1' });
    expect(out[1].labels).toEqual({ app: 'b' });
    // Read-time masking runs on every line.
    expect(out[0].line).toBe(maskLine(secretLine));
  });

  it('sorts oldest-first for a forward read, and tolerates a base URL with a trailing slash', async () => {
    process.env.LOKI_URL = `${base}/`;
    handler = (_req, _url, res) => json(res, 200, streams([
      { stream: {}, values: [[ns(30), 'c']] },
      { stream: {}, values: [[ns(10), 'a'], [ns(20), 'b']] },
    ]));
    const out = await queryLogs('{}', 't', { startMs: 0, endMs: 100, limit: 5, direction: 'forward' });
    expect(out.map((e) => e.line)).toEqual(['a', 'b', 'c']);
    expect(requests[0].url.searchParams.get('direction')).toBe('forward');
  });

  it('a non-success envelope is an upstream-4xx carrying Loki\'s error', async () => {
    handler = (_req, _url, res) => json(res, 200, { status: 'error', error: 'parse error at line 1' });
    await expect(queryLogs('{', 't', { startMs: 0, endMs: 1, limit: 1 })).rejects.toEqual({
      kind: 'upstream-4xx', status: 200, message: 'parse error at line 1',
    });
  });

  it('an envelope with no data (and no message) gets a generic message', async () => {
    handler = (_req, _url, res) => json(res, 200, { status: 'success' });
    await expect(queryLogs('{}', 't', { startMs: 0, endMs: 1, limit: 1 })).rejects.toMatchObject({
      kind: 'upstream-4xx', message: 'Loki returned a non-success envelope',
    });
  });

  it('a 400 from Loki is upstream-4xx; a 503 is unreachable — and neither is retried', async () => {
    handler = (_req, _url, res) => json(res, 400, { message: 'bad query' });
    await expect(queryLogs('{}', 't', { startMs: 0, endMs: 1, limit: 1 })).rejects.toMatchObject({ kind: 'upstream-4xx', status: 400 });
    expect(requests).toHaveLength(1);

    handler = (_req, _url, res) => { res.writeHead(503); res.end('overloaded'); };
    await expect(queryLogs('{}', 't', { startMs: 0, endMs: 1, limit: 1 })).rejects.toMatchObject({ kind: 'unreachable' });
    expect(requests).toHaveLength(2);
  });

  it('a refused connection is unreachable', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    process.env.LOKI_URL = `http://127.0.0.1:${port}`;
    await expect(queryLogs('{}', 't', { startMs: 0, endMs: 1, limit: 1 })).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

describe('queryLogVolume', () => {
  it('sends second-resolution bounds + step and returns Prometheus-shaped series', async () => {
    handler = (_req, _url, res) => json(res, 200, {
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: { level: 'error' }, values: [[1700000000, '4'], [1700000060, '7']] }] },
    });
    const out = await queryLogVolume('sum by (level) (count_over_time({}[1m]))', 'org-1', 1_700_000_000_500, 1_700_000_120_999, '60s');
    expect(Object.fromEntries(requests[0].url.searchParams)).toMatchObject({ start: '1700000000', end: '1700000120', step: '60s' });
    expect(out).toEqual([{ labels: { level: 'error' }, values: [{ time: 1700000000, value: '4' }, { time: 1700000060, value: '7' }] }]);
  });
});

describe('iterateLogs', () => {
  /** A fake Loki holding `rows` (ms, line), answering forward range reads like the real one. */
  const fakeLoki = (rows: Array<[number, string]>): Handler => (_req, url, res) => {
    const start = Number(url.searchParams.get('start')) / 1e6;
    const end = Number(url.searchParams.get('end')) / 1e6;
    const limit = Number(url.searchParams.get('limit'));
    const hit = rows.filter(([t]) => t >= start && t <= end).slice(0, limit);
    json(res, 200, streams([{ stream: {}, values: hit.map(([t, l]) => [ns(t), l]) }]));
  };

  const collect = async (gen: AsyncGenerator<Array<{ line: string }>>) => {
    const pages: string[][] = [];
    for await (const p of gen) pages.push(p.map((e) => e.line));
    return pages;
  };

  it('pages oldest-first and re-queries from the boundary instant WITHOUT dropping or repeating its lines', async () => {
    // Three lines share t=20 and straddle the page boundary.
    handler = fakeLoki([[10, 'a'], [20, 'b1'], [20, 'b2'], [20, 'b3'], [30, 'c'], [40, 'd']]);
    const pages = await collect(iterateLogs('{}', 't', { startMs: 0, endMs: 100, pageSize: 3, maxEntries: 100, deadlineMs: 10_000 }));
    expect(pages.flat()).toEqual(['a', 'b1', 'b2', 'b3', 'c', 'd']);
    expect(new Set(pages.flat()).size).toBe(6);
  });

  it('an instant with more lines than a page steps past itself instead of truncating everything after it', async () => {
    // pageSize 2, three lines at t=20: the re-query from 20 can only ever see
    // b1,b2. The walk used to END there, dropping c and d silently.
    handler = fakeLoki([[10, 'a'], [20, 'b1'], [20, 'b2'], [20, 'b3'], [30, 'c'], [40, 'd']]);
    const lines = (await collect(iterateLogs('{}', 't', { startMs: 0, endMs: 100, pageSize: 2, maxEntries: 100, deadlineMs: 10_000 }))).flat();
    expect(lines).toEqual(expect.arrayContaining(['a', 'b1', 'b2', 'c', 'd']));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('a page that is entirely the already-sent boundary instant ends the walk', async () => {
    handler = fakeLoki([[5, 'x'], [5, 'y']]);
    const pages = await collect(iterateLogs('{}', 't', { startMs: 5, endMs: 100, pageSize: 2, maxEntries: 100, deadlineMs: 10_000 }));
    expect(pages.flat()).toEqual(['x', 'y']);
  });

  it('stops at maxEntries (the export\'s safety cap), trimming the last page', async () => {
    handler = fakeLoki(Array.from({ length: 20 }, (_, i) => [i + 1, `l${i + 1}`] as [number, string]));
    const pages = await collect(iterateLogs('{}', 't', { startMs: 0, endMs: 100, pageSize: 4, maxEntries: 6, deadlineMs: 10_000 }));
    expect(pages.flat()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  });

  it('an empty window yields nothing', async () => {
    handler = fakeLoki([]);
    expect(await collect(iterateLogs('{}', 't', { startMs: 0, endMs: 100, pageSize: 4, maxEntries: 6, deadlineMs: 10_000 }))).toEqual([]);
  });

  it('stops once the wall-clock deadline has passed', async () => {
    let calls = 0;
    const slow = fakeLoki(Array.from({ length: 50 }, (_, i) => [i + 1, `l${i}`] as [number, string]));
    handler = (req, url, res) => { calls += 1; setTimeout(() => slow(req, url, res), 30); };
    await collect(iterateLogs('{}', 't', { startMs: 0, endMs: 100, pageSize: 2, maxEntries: 1000, deadlineMs: 20 }));
    // One page in flight crosses the deadline; the next iteration returns.
    expect(calls).toBe(1);
  });

  it('propagates an upstream failure mid-walk', async () => {
    let n = 0;
    const ok = fakeLoki([[1, 'a'], [2, 'b'], [3, 'c']]);
    handler = (req, url, res) => { n += 1; if (n === 1) ok(req, url, res); else json(res, 500, { message: 'boom' }); };
    const gen = iterateLogs('{}', 't', { startMs: 0, endMs: 100, pageSize: 2, maxEntries: 100, deadlineMs: 10_000 });
    expect((await gen.next()).value).toHaveLength(2);
    await expect(gen.next()).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
