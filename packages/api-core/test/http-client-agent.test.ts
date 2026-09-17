// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep-alive agents are shared per target. Clients are often built per call
 * (the org-hierarchy walk builds one per hop), so a per-client agent opened a
 * fresh TCP connection for every client and its socket cap bounded nothing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { InternalHttpClient, destroySharedHttpAgents } from '../src/services/http-client.js';

describe('InternalHttpClient shared keep-alive agent', () => {
  let server: http.Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    server.on('connection', () => { connections++; });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    destroySharedHttpAgents();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reuses one pooled connection across separately constructed clients for the same host:port', async () => {
    connections = 0;
    for (let i = 0; i < 5; i++) {
      const client = new InternalHttpClient({ host: '127.0.0.1', port });
      const res = await client.get('/x');
      expect(res.statusCode).toBe(200);
    }
    expect(connections).toBe(1);
  });

  it('a caller-supplied agent is used as-is', async () => {
    connections = 0;
    const agent = new http.Agent({ keepAlive: false });
    const client = new InternalHttpClient({ host: '127.0.0.1', port }, { agent });
    await client.get('/y');
    await client.get('/y');
    expect(connections).toBe(2);
    agent.destroy();
  });
});
