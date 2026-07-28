// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the ticket-gated SSE logs endpoints wired in
 * app-factory: `POST /logs/ticket` (mint) and `GET /logs/:requestId` (stream).
 *
 * Locks in the Wave 2b security fix: the log stream is no longer world-readable.
 * A ticket must be minted by an authenticated caller (bound to their org) and
 * then presented on the stream; an anonymous stream subscribe is a 401.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

const TEST_SECRET = 'test-secret-for-logs-ticket';
process.env.JWT_SECRET = TEST_SECRET;
process.env.NODE_ENV = 'test';

// Mock uuid (ESM-only) and createLogger (Winston open handles) before imports.
jest.unstable_mockModule('uuid', () => ({ v7: () => '00000000-0000-0000-0000-000000000000' }));
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const jwt = (await import('jsonwebtoken')).default;
const { createApp } = await import('../src/api/app-factory.js');

function signAccess(payload: Record<string, unknown>): string {
  return jwt.sign({ type: 'access', sub: 'user-1', role: 'member', ...payload }, TEST_SECRET);
}

describe('POST /logs/ticket (app-factory)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { app } = createApp({ enableRateLimit: false, enableOpenApi: false, enableHelmet: false });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const REQ_ID = '11111111-1111-1111-1111-111111111111';

  /** Mint a ticket bound to `requestId` for the given token. */
  function mint(token: string, requestId: string = REQ_ID) {
    return fetch(`${base}/logs/ticket`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  }

  it('rejects an unauthenticated mint request (401)', async () => {
    const res = await fetch(`${base}/logs/ticket`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('mints a ticket for an authenticated caller with an org + requestId (200)', async () => {
    const res = await mint(signAccess({ organizationId: 'org-acme' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { ticket?: string } };
    expect(typeof body.data?.ticket).toBe('string');
    expect(body.data?.ticket?.length).toBeGreaterThan(0);
  });

  it('rejects a mint with no requestId (400)', async () => {
    const token = signAccess({ organizationId: 'org-acme' });
    const res = await fetch(`${base}/logs/ticket`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a mint with a malformed requestId (400)', async () => {
    const res = await mint(signAccess({ organizationId: 'org-acme' }), 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('rejects an authenticated token that carries no organization (400)', async () => {
    const res = await mint(signAccess({})); // no organizationId claim
    expect(res.status).toBe(400);
  });

  it('minted ticket admits the bound stream once (200 text/event-stream)', async () => {
    const mintRes = await mint(signAccess({ organizationId: 'org-acme' }));
    const { data } = await mintRes.json() as { data: { ticket: string } };

    const ctrl = new AbortController();
    const streamRes = await fetch(`${base}/logs/${REQ_ID}?ticket=${encodeURIComponent(data.ticket)}`, {
      signal: ctrl.signal,
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort(); // close the stream so the server can shut down cleanly
  });

  it('rejects presenting a ticket on a DIFFERENT stream subject (401)', async () => {
    // A ticket minted for REQ_ID must not open some other org/subject's stream.
    const mintRes = await mint(signAccess({ organizationId: 'org-acme' }));
    const { data } = await mintRes.json() as { data: { ticket: string } };

    const otherReqId = '33333333-3333-3333-3333-333333333333';
    const res = await fetch(`${base}/logs/${otherReqId}?ticket=${encodeURIComponent(data.ticket)}`);
    expect(res.status).toBe(401);
  });

  it('rejects an anonymous stream subscribe with no ticket (401)', async () => {
    const reqId = '22222222-2222-2222-2222-222222222222';
    const res = await fetch(`${base}/logs/${reqId}`);
    expect(res.status).toBe(401);
  });
});
