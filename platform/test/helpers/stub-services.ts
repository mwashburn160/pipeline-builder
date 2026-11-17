// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stand-in downstream services for the route-level integration suites. Imports
 * NOTHING from src: it must be started before the platform config is loaded, so
 * the suite can point `MESSAGE_SERVICE_*` / `QUOTA_SERVICE_*` at it.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the stub services received. */
export interface StubCall { method: string; path: string; body: unknown }

/**
 * A stand-in for the message + quota services: answers every request 2xx and
 * records it. Quota checks report "not exceeded"; a system notification is
 * "persisted". Call this BEFORE importing `config`, and point the env at it.
 */
export async function startStubServices(): Promise<{ base: string; port: number; calls: StubCall[]; close: () => Promise<void> }> {
  const calls: StubCall[] = [];
  const handler: http.RequestListener = (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep raw */ }
      calls.push({ method: req.method ?? '', path: req.url ?? '', body });
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        statusCode: 200,
        data: { exceeded: false, allowed: true, limit: -1, used: 0, remaining: -1, unlimited: true },
      }));
    });
  };
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    calls,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
