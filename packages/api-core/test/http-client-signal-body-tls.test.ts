// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * InternalHttpClient against REAL local servers:
 *  - caller cancellation (AbortSignal) — before the call, mid-request, and
 *    mid-retry-back-off — rejects with the signal's reason, destroys the
 *    request, and never feeds the circuit breaker;
 *  - an unparseable body is distinguishable from `{}`: a 2xx rejects with
 *    InvalidResponseBodyError, a 4xx/5xx resolves with `bodyInvalid: true`;
 *  - the transport follows the target's scheme (a TLS ClientHello reaches an
 *    `https://` target; plain HTTP reaches an `http` one).
 */

import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import type { HttpClientResponse } from '../src/index.js';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { InternalHttpClient, InvalidResponseBodyError, destroySharedHttpAgents } = await import('../src/services/http-client.js');
const { getCircuitBreaker, circuitBreakerKey, resetCircuitBreakers } = await import('../src/services/circuit-breaker.js');

let server: http.Server;
let port: number;
let hits: Record<string, number> = {};
let closedMidRequest = 0;
const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {
  '/ok': (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); },
  '/empty': (_req, res) => { res.writeHead(200); res.end(); },
  '/html-200': (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>not json</html>'); },
  '/html-502': (_req, res) => { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>bad gateway</html>'); },
  '/json-404': (_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"message":"nope"}'); },
  // Never answers: only a cancellation (or the deadline) ends the request.
  '/hang': (req) => { req.on('close', () => { closedMidRequest++; }); },
  '/503': (_req, res) => { res.writeHead(503); res.end('{}'); },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits[req.url ?? ''] = (hits[req.url ?? ''] ?? 0) + 1;
    (routes[req.url ?? ''] ?? routes['/ok'])(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  destroySharedHttpAgents();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  resetCircuitBreakers();
  hits = {};
  closedMidRequest = 0;
});

const client = (timeout = 2000) => new InternalHttpClient({ host: '127.0.0.1', port, timeout });
const breaker = () => getCircuitBreaker(circuitBreakerKey(`127.0.0.1:${port}`));

describe('AbortSignal passthrough', () => {
  it('an already-aborted signal rejects with its reason without touching the network', async () => {
    const reason = new Error('caller gave up');
    await expect(client().get('/ok', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(hits['/ok']).toBeUndefined();
  });

  it('aborting mid-request destroys the in-flight request and rejects promptly', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = client(10_000).get('/hang', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2000);
    // The server sees the connection go away — the request was cancelled, not abandoned.
    await new Promise((r) => setTimeout(r, 50));
    expect(closedMidRequest).toBe(1);
    // A cancellation is not a downstream fault, and a GET is not retried after it.
    expect(hits['/hang']).toBe(1);
    expect(breaker().getState()).toBe('closed');
  });

  it('aborting during a retry back-off stops the retries', async () => {
    const controller = new AbortController();
    const reason = new Error('shutdown');
    const p = client().get('/503', { signal: controller.signal, retryDelayMs: 5_000, maxRetries: 3 });
    setTimeout(() => controller.abort(reason), 100);
    await expect(p).rejects.toBe(reason);
    expect(hits['/503']).toBe(1);
  });

  it('aborting during the back-off after a CONNECTION error stops the retries', async () => {
    // A port nothing listens on: every attempt is a connection error.
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const controller = new AbortController();
    const reason = new Error('stop');
    const c = new InternalHttpClient({ host: '127.0.0.1', port: deadPort, timeout: 1000 });
    const p = c.get('/x', { signal: controller.signal, retryDelayMs: 5_000, maxRetries: 3 });
    setTimeout(() => controller.abort(reason), 100);
    await expect(p).rejects.toBe(reason);
    expect(getCircuitBreaker(circuitBreakerKey(`127.0.0.1:${deadPort}`)).getState()).toBe('closed');
  });

  it('a non-Error abort reason still rejects with an Error', async () => {
    const controller = new AbortController();
    controller.abort('plain string');
    await expect(client().get('/ok', { signal: controller.signal })).rejects.toThrow('plain string');
  });

  it('a signal that never aborts changes nothing (and its listener is removed)', async () => {
    const controller = new AbortController();
    const res = await client().get('/ok', { signal: controller.signal });
    expect(res.body).toEqual({ ok: true });
    controller.abort(); // after settling: no effect, no throw
  });

  it('frees a half-open probe slot when the caller cancels it', async () => {
    const b = breaker();
    for (let i = 0; i < 10; i++) b.recordFailure();
    expect(b.getState()).toBe('open');
    // Jump past the cooldown so the next request is admitted as the half-open probe.
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
    try {
      const controller = new AbortController();
      const p = client(10_000).get('/hang', { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      // The slot is free: the next request probes (and its success closes the breaker).
      await expect(client().get('/ok')).resolves.toMatchObject({ statusCode: 200 });
      expect(b.getState()).toBe('closed');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('response bodies: unparseable vs empty', () => {
  it('an empty body is still `{}` and carries no flag', async () => {
    const res: HttpClientResponse = await client().get('/empty');
    expect(res.body).toEqual({});
    expect(res.bodyInvalid).toBeUndefined();
  });

  it('a 2xx with a non-JSON body rejects with InvalidResponseBodyError (not retried, not a breaker fault)', async () => {
    const err = await client().get('/html-200').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidResponseBodyError);
    expect(err).toMatchObject({ code: 'INVALID_RESPONSE_BODY', statusCode: 200, bodySnippet: '<html>not json</html>' });
    expect(hits['/html-200']).toBe(1);
    expect(breaker().getState()).toBe('closed');
  });

  it('a 5xx with a non-JSON body resolves with bodyInvalid (status-driven handling keeps working)', async () => {
    const res = await client().get('/html-502', { maxRetries: 0 });
    expect(res).toMatchObject({ statusCode: 502, body: {}, bodyInvalid: true });
  });

  it('a JSON error body is parsed normally', async () => {
    const res = await client().get('/json-404');
    expect(res.body).toEqual({ message: 'nope' });
    expect(res.bodyInvalid).toBeUndefined();
  });
});

describe('transport follows the target scheme', () => {
  let tcp: net.Server;
  let tcpPort: number;
  let firstBytes: Buffer[] = [];

  beforeAll(async () => {
    tcp = net.createServer((socket) => {
      socket.once('data', (chunk: Buffer) => { firstBytes.push(chunk); socket.destroy(); });
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
    tcpPort = (tcp.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((r) => tcp.close(() => r())); });
  beforeEach(() => { firstBytes = []; });

  // 0x16 = TLS handshake record: the client opened with a ClientHello.
  const TLS_HANDSHAKE = 0x16;

  it('an https:// URL host speaks TLS to the URL\'s host and port', async () => {
    const c = new InternalHttpClient({ host: `https://127.0.0.1:${tcpPort}`, port: 1, timeout: 1000 });
    await expect(c.get('/x', { maxRetries: 0 })).rejects.toThrow();
    expect(firstBytes[0]?.[0]).toBe(TLS_HANDSHAKE);
  });

  it('protocol: "https" on a bare host speaks TLS', async () => {
    const c = new InternalHttpClient({ host: '127.0.0.1', port: tcpPort, protocol: 'https', timeout: 1000 });
    await expect(c.get('/x', { maxRetries: 0 })).rejects.toThrow();
    expect(firstBytes[0]?.[0]).toBe(TLS_HANDSHAKE);
  });

  it('an http:// URL host (and the default) speak plain HTTP', async () => {
    const viaUrl = new InternalHttpClient({ host: `http://127.0.0.1:${tcpPort}`, port: 1, timeout: 1000 });
    await expect(viaUrl.get('/x', { maxRetries: 0 })).rejects.toThrow();
    const bare = new InternalHttpClient({ host: '127.0.0.1', port: tcpPort, timeout: 1000 });
    await expect(bare.get('/y', { maxRetries: 0 })).rejects.toThrow();
    expect(firstBytes.map((b) => b.toString('latin1').split('\r\n')[0])).toEqual(['GET /x HTTP/1.1', 'GET /y HTTP/1.1']);
  });

  it('a URL host without a port falls back to the config port', async () => {
    const c = new InternalHttpClient({ host: 'http://127.0.0.1', port: tcpPort, timeout: 1000 });
    await expect(c.get('/z', { maxRetries: 0 })).rejects.toThrow();
    expect(firstBytes).toHaveLength(1);
  });

  it('rejects a non-http(s) URL scheme at construction', () => {
    expect(() => new InternalHttpClient({ host: 'ftp://127.0.0.1', port: 21 })).toThrow('Unsupported service URL scheme: ftp:');
  });
});
