// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The internal HTTP client against a REAL local server misbehaving in the ways
 * a peer actually can: dropping the connection mid-body, trickling bytes so the
 * socket never goes idle, sending an enormous body. Each must settle the
 * promise (never hang) with the right error — a hung promise is also a
 * half-open breaker probe that never reports back.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { InternalHttpClient, ResponseTooLargeError, destroySharedHttpAgents } = await import('../src/services/http-client.js');
const { getCircuitBreaker, circuitBreakerKey, resetCircuitBreakers } = await import('../src/services/circuit-breaker.js');

let server: http.Server;
let port: number;
const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {
  '/ok': (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); },
  // Headers + part of the body, then the connection is cut.
  '/drop': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"partial":');
    setTimeout(() => res.socket?.destroy(), 20);
  },
  // One byte every 40ms: never idle long enough for the socket timeout.
  '/trickle': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const t = setInterval(() => { if (!res.write(' ')) { /* backpressure irrelevant */ } }, 40);
    res.on('close', () => clearInterval(t));
  },
  '/huge': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`"${'x'.repeat(64 * 1024)}"`);
  },
  '/fail': (_req, res) => { res.writeHead(503); res.end('{}'); },
};

beforeAll(async () => {
  server = http.createServer((req, res) => (routes[req.url ?? ''] ?? routes['/ok'])(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  destroySharedHttpAgents();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => resetCircuitBreakers());

const client = (timeout = 2000, opts: ConstructorParameters<typeof InternalHttpClient>[1] = {}) =>
  new InternalHttpClient({ host: '127.0.0.1', port, timeout }, opts);

describe('InternalHttpClient — settles on every peer failure', () => {
  it('still returns a normal response', async () => {
    await expect(client().get('/ok')).resolves.toMatchObject({ statusCode: 200, body: { ok: true } });
  });

  it('rejects (does not hang) when the peer cuts the connection mid-body', async () => {
    await expect(client().get('/drop', { maxRetries: 0 })).rejects.toThrow(/aborted|closed|socket hang up|ECONNRESET/i);
  });

  it('enforces a TOTAL deadline against a peer trickling bytes, naming the effective timeout', async () => {
    const started = Date.now();
    await expect(client(5000).get('/trickle', { timeout: 250, maxRetries: 0 })).rejects.toThrow('Request timeout after 250ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('caps the response body and does not retry an oversized one', async () => {
    const p = client(2000, { maxResponseBytes: 1024 }).get('/huge');
    await expect(p).rejects.toBeInstanceOf(ResponseTooLargeError);
    // A per-call cap overrides the client default.
    await expect(client().get('/huge', { maxResponseBytes: 10 })).rejects.toThrow('exceeded 10 bytes');
    await expect(client().get('/huge')).resolves.toMatchObject({ statusCode: 200 });
  });
});

describe('InternalHttpClient — breaker per route class', () => {
  it('failures in one class do not open the breaker another class rides on', async () => {
    const audit = client(2000, { breakerClass: 'audit' });
    for (let i = 0; i < 10; i++) await audit.post('/fail', {}, { maxRetries: 0 }).catch(() => undefined);
    const target = `127.0.0.1:${port}`;
    expect(getCircuitBreaker(circuitBreakerKey(target, 'audit')).getState()).toBe('open');
    expect(getCircuitBreaker(circuitBreakerKey(target)).getState()).toBe('closed');
    await expect(client().get('/ok')).resolves.toMatchObject({ statusCode: 200 });
  });

  it('the default class keys by host:port alone', () => {
    expect(circuitBreakerKey('h:1')).toBe('h:1');
    expect(circuitBreakerKey('h:1', 'default')).toBe('h:1');
    expect(circuitBreakerKey('h:1', 'audit')).toBe('h:1#audit');
  });
});
