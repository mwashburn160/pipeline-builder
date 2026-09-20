// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSEManager + registerSseTicketChannel regressions:
 * - closeRequest's final frame is local-only and never double-decrements org counts;
 * - org-keyed channels are capped per ORG, not by the per-request cap;
 * - registering an org channel turns on the cross-pod relay.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const TEST_SECRET = 'test-secret-org-channel';
process.env.JWT_SECRET = TEST_SECRET;

jest.unstable_mockModule('uuid', () => {
  let n = 0;
  return { v7: () => `uuid-${++n}` };
});
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as typeof import('@pipeline-builder/api-core');
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const express = (await import('express')).default;
const { generateTestSigningKey, installTestJwks, signTestUserToken } =
  await import('@pipeline-builder/api-core/lib/testing/user-tokens.js');

// Access tokens are ES256, signed only by platform; install the published key
// set (in-memory) so the real `requireAuth` can verify what we mint.
const signingKey = generateTestSigningKey();
installTestJwks([signingKey]);
const { SSEManager } = await import('../src/http/sse-connection-manager.js');
const { registerSseTicketChannel } = await import('../src/http/sse-ticket-channel.js');
type SSERelay = import('../src/http/sse-relay.js').SSERelay;

function mockSseRes() {
  const handlers: Record<string, Array<() => void>> = {};
  const res: any = {
    writtenData: [] as string[],
    writableEnded: false,
    setHeader() {},
    write(data: string) { res.writtenData.push(data); return true; },
    end() { res.writableEnded = true; },
    flushHeaders() {},
    on(event: string, handler: () => void) { (handlers[event] ||= []).push(handler); },
  };
  return res;
}

function fakeRelay() {
  const relay = { publish: jest.fn(), subscribe: jest.fn(), close: jest.fn(async () => undefined) };
  return relay as typeof relay & SSERelay;
}

const managers: Array<InstanceType<typeof SSEManager>> = [];
const servers: Server[] = [];
afterEach(async () => {
  while (managers.length) managers.pop()!.shutdown();
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
const make = (opts: ConstructorParameters<typeof SSEManager>[0] = {}) => {
  const m = new SSEManager({ cleanupIntervalMs: 60_000, ...opts });
  managers.push(m);
  return m;
};

describe('SSEManager.closeRequest', () => {
  it('sends the final frame to local clients only — it is not relayed to other pods', () => {
    const relay = fakeRelay();
    const m = make({ relay });
    const res = mockSseRes();
    m.addClient('req-1', res, 'org-a');
    m.closeRequest('req-1', 'Build finished');
    expect(res.writtenData.join('')).toContain('Build finished');
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it('does not double-decrement the org count for a client already gone when the final frame is written', () => {
    const m = make({ maxClientsPerOrg: 10 });
    const gone = mockSseRes();
    const live = mockSseRes();
    const other = mockSseRes();
    m.addClient('req-1', gone, 'org-a');
    m.addClient('req-1', live, 'org-a');
    m.addClient('req-2', other, 'org-a'); // a different stream of the same org stays open
    gone.writableEnded = true; // socket already ended; the final write removes it
    m.closeRequest('req-1', 'done');
    expect(m.getOrgClientCount('org-a')).toBe(1);
  });
});

describe('org-keyed SSE channel', () => {
  async function startChannel(manager: InstanceType<typeof SSEManager>) {
    const app = express();
    const ticketStore = actualApiCore.createMemorySseTicketStore({ ttlMs: 30_000, maxTotal: 100, maxPerOrg: 100 });
    registerSseTicketChannel(app, { ticketPath: '/n/ticket', streamPath: '/n', ticketStore, sseManager: manager, label: 'notification' });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = (org: string) => signTestUserToken({
      type: 'access',
      sub: 'u1',
      role: 'member',
      organizationId: org,
      // The identity claims requireAuth requires (see api-core hasValidIdentityClaims).
      principalType: 'user',
      token_use: 'access',
      amr: ['pwd'],
      aal: 1,
      auth_time: 1_700_000_000,
    }, { key: signingKey });
    const open = async (org: string): Promise<number> => {
      const t = await fetch(`${base}/n/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token(org)}` } });
      const { data } = (await t.json()) as { data: { ticket: string } };
      const ctrl = new AbortController();
      const res = await fetch(`${base}/n?ticket=${encodeURIComponent(data.ticket)}`, { signal: ctrl.signal });
      return res.status;
    };
    return { open, ticketStore };
  }

  it('caps streams per ORG (not by the per-request cap) and counts them against the org', async () => {
    const m = make({ maxClientsPerRequest: 1, maxClientsPerOrg: 3 });
    const { open, ticketStore } = await startChannel(m);
    try {
      expect(await open('org-a')).toBe(200);
      expect(await open('org-a')).toBe(200); // previously 429: the per-request cap (1) applied
      expect(await open('org-a')).toBe(200);
      expect(m.getOrgClientCount('org-a')).toBe(3);
      expect(await open('org-a')).toBe(429); // the per-org cap
      expect(await open('org-b')).toBe(200); // other orgs unaffected
    } finally {
      ticketStore.stop();
    }
  });

  it('turns on the cross-pod relay when the channel is registered', async () => {
    const relay = fakeRelay();
    const factory = jest.fn(() => relay);
    const m = make({ relayFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    const { ticketStore } = await startChannel(m);
    ticketStore.stop();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(relay.subscribe).toHaveBeenCalledTimes(1);
    m.send('org-a', 'MESSAGE', 'hi');
    expect(relay.publish).toHaveBeenCalledTimes(1);
  });
});
