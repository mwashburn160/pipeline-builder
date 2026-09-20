// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Services mount several route chains on one prefix, each carrying the
 * idempotency middleware (`app.use('/plugins', ...createAuthenticatedWithOrgRoute(), router)`
 * repeated). A keyed request that falls through the first router runs the
 * middleware a second time; that pass must not see its own pending
 * reservation and answer 409.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const express = (await import('express')).default;
const { idempotencyMiddleware, createMemoryStore } = await import('../src/api/idempotency-middleware.js');

describe('idempotency across stacked route chains', () => {
  let server: Server;
  let base: string;
  let executions = 0;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const store = createMemoryStore();
    const fakeAuth: import('express').RequestHandler = (req, _res, next) => {
      (req as unknown as { user: unknown }).user = { organizationId: 'org-1', sub: 'user-1' };
      next();
    };

    // Chain 1: a router that does NOT handle POST /things/create.
    const first = express.Router();
    first.get('/list', (_req, res) => { res.json({ ok: true }); });
    // Chain 2: the router that does.
    const second = express.Router();
    second.post('/create', (_req, res) => { executions++; res.status(201).json({ created: executions }); });

    app.use('/things', fakeAuth, idempotencyMiddleware({ store }), first);
    app.use('/things', fakeAuth, idempotencyMiddleware({ store }), second);

    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = () => fetch(`${base}/things/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
    body: JSON.stringify({ name: 'a' }),
  });

  it('runs the handler once and does not 409 on its own reservation', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: 1 });
  });

  it('a retry with the same key replays the cached response without re-running', async () => {
    // Allow the async store.set from the first response to land.
    await new Promise((r) => setTimeout(r, 20));
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.headers.get('x-idempotent-replayed')).toBe('true');
    expect(await res.json()).toEqual({ created: 1 });
    expect(executions).toBe(1);
  });
});
