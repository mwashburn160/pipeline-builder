// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';

// Mock uuid (ESM-only module) and createLogger (Winston open handles) before imports
jest.unstable_mockModule('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  ...actualApiCore,
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  createCacheService: () => ({
    getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
    invalidatePattern: () => Promise.resolve(0),
  }),
}));

const { SSEManager } = await import('../src/http/sse-connection-manager.js');

// Mock Response
function mockSseRes() {
  const res: any = {
    writtenData: [] as string[],
    ended: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value; },
    write(data: string) { res.writtenData.push(data); return true; },
    end() { res.ended = true; },
    flushHeaders() {},
    on(event: string, handler: () => void) {
      if (event === 'close') res._closeHandler = handler;
    },
    _closeHandler: null as (() => void) | null,
  };
  return res;
}

// Tests

describe('SSEManager', () => {
  let manager: InstanceType<typeof SSEManager>;

  beforeEach(() => {
    manager = new SSEManager({
      maxClientsPerRequest: 3,
      clientTimeoutMs: 60000,
      cleanupIntervalMs: 0, // Disable automatic cleanup
    });
  });

  afterEach(() => {
    manager.shutdown();
  });

  describe('getStats', () => {
    it('should return empty stats initially', () => {
      const stats = manager.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalClients).toBe(0);
      expect(stats.oldestConnectionMs).toBeNull();
    });

    it('should track connected clients', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      const stats = manager.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalClients).toBe(1);
      expect(stats.oldestConnectionMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('hasClients', () => {
    it('should return false when no clients connected', () => {
      expect(manager.hasClients('nonexistent')).toBe(false);
    });

    it('should return true when client is connected', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      expect(manager.hasClients('req-1')).toBe(true);
    });
  });

  describe('getClientCount', () => {
    it('should return 0 for no clients', () => {
      expect(manager.getClientCount('nonexistent')).toBe(0);
    });

    it('should count clients per request', () => {
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-1', mockSseRes());
      expect(manager.getClientCount('req-1')).toBe(2);
    });
  });

  describe('addClient', () => {
    it('should add a client and return true', () => {
      const res = mockSseRes();
      const added = manager.addClient('req-1', res);
      expect(added).toBe(true);
      expect(manager.getClientCount('req-1')).toBe(1);
    });

    it('should reject when max clients reached', () => {
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-1', mockSseRes());
      const added = manager.addClient('req-1', mockSseRes());
      expect(added).toBe(false);
      expect(manager.getClientCount('req-1')).toBe(3);
    });

    it('should handle different request IDs independently', () => {
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-2', mockSseRes());
      expect(manager.getClientCount('req-1')).toBe(1);
      expect(manager.getClientCount('req-2')).toBe(1);
    });
  });

  describe('send', () => {
    it('should send SSE event to connected clients', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      const count = manager.send('req-1', 'INFO', 'Hello');
      expect(count).toBe(1);
      expect(res.writtenData.length).toBeGreaterThan(0);
      expect(res.writtenData.join('')).toContain('Hello');
    });

    it('should return 0 for unknown request', () => {
      expect(manager.send('unknown', 'INFO', 'test')).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('should send to all connected clients', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      manager.addClient('req-1', res1);
      manager.addClient('req-2', res2);
      const count = manager.broadcast('INFO', 'Broadcast msg');
      expect(count).toBe(2);
    });

    it('should return 0 with no clients', () => {
      expect(manager.broadcast('INFO', 'test')).toBe(0);
    });
  });

  describe('closeRequest', () => {
    it('should close all clients for a request', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      manager.addClient('req-1', res1);
      manager.addClient('req-1', res2);
      manager.closeRequest('req-1');
      expect(manager.hasClients('req-1')).toBe(false);
      expect(res1.ended).toBe(true);
      expect(res2.ended).toBe(true);
    });

    it('should handle closing non-existent request', () => {
      expect(() => manager.closeRequest('nonexistent')).not.toThrow();
    });

    it('should send final message before closing', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      manager.closeRequest('req-1', 'Goodbye');
      expect(res.writtenData.join('')).toContain('Goodbye');
      expect(res.ended).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should close all connections', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      manager.addClient('req-1', res1);
      manager.addClient('req-2', res2);
      manager.shutdown();
      expect(manager.getStats().totalClients).toBe(0);
    });
  });

  describe('removeClient on close', () => {
    it('should remove client when response closes', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      expect(manager.getClientCount('req-1')).toBe(1);
      // Simulate response close
      if (res._closeHandler) res._closeHandler();
      expect(manager.getClientCount('req-1')).toBe(0);
    });
  });

  describe('per-org client cap', () => {
    let capManager: InstanceType<typeof SSEManager>;
    beforeEach(() => {
      capManager = new SSEManager({
        maxClientsPerRequest: 100,
        maxClientsPerOrg: 2,
        clientTimeoutMs: 60000,
        cleanupIntervalMs: 0,
      });
    });
    afterEach(() => capManager.shutdown());

    it('tracks open-stream count by org', () => {
      expect(capManager.getOrgClientCount('org-a')).toBe(0);
      capManager.addClient('req-1', mockSseRes(), 'org-a');
      capManager.addClient('req-2', mockSseRes(), 'org-a');
      expect(capManager.getOrgClientCount('org-a')).toBe(2);
    });

    it('rejects the (cap+1)th connection for an org', () => {
      expect(capManager.addClient('req-1', mockSseRes(), 'org-a')).toBe(true);
      expect(capManager.addClient('req-2', mockSseRes(), 'org-a')).toBe(true);
      expect(capManager.addClient('req-3', mockSseRes(), 'org-a')).toBe(false);
    });

    it('does NOT count anonymous connections (orgId omitted)', () => {
      // Three anonymous streams should still succeed despite cap=2,
      // because the per-org check is skipped without an orgId.
      expect(capManager.addClient('r1', mockSseRes())).toBe(true);
      expect(capManager.addClient('r2', mockSseRes())).toBe(true);
      expect(capManager.addClient('r3', mockSseRes())).toBe(true);
      expect(capManager.getOrgClientCount('org-a')).toBe(0);
    });

    it('counters are independent across orgs', () => {
      capManager.addClient('r1', mockSseRes(), 'org-a');
      capManager.addClient('r2', mockSseRes(), 'org-a');
      capManager.addClient('r3', mockSseRes(), 'org-b');
      capManager.addClient('r4', mockSseRes(), 'org-b');
      expect(capManager.getOrgClientCount('org-a')).toBe(2);
      expect(capManager.getOrgClientCount('org-b')).toBe(2);
      // Each org at its cap; a third connection for either is rejected.
      expect(capManager.addClient('r5', mockSseRes(), 'org-a')).toBe(false);
      expect(capManager.addClient('r6', mockSseRes(), 'org-b')).toBe(false);
    });

    it('decrements the org counter when a client disconnects', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      capManager.addClient('r1', res1, 'org-a');
      capManager.addClient('r2', res2, 'org-a');
      expect(capManager.getOrgClientCount('org-a')).toBe(2);

      // Simulate one client disconnecting — a third connection now fits.
      if (res1._closeHandler) res1._closeHandler();
      expect(capManager.getOrgClientCount('org-a')).toBe(1);
      expect(capManager.addClient('r3', mockSseRes(), 'org-a')).toBe(true);
    });

    it('closeRequest decrements the org counter for every closed client', () => {
      capManager.addClient('r1', mockSseRes(), 'org-a');
      capManager.addClient('r2', mockSseRes(), 'org-a');
      expect(capManager.getOrgClientCount('org-a')).toBe(2);

      capManager.closeRequest('r1');
      expect(capManager.getOrgClientCount('org-a')).toBe(1);
      capManager.closeRequest('r2');
      expect(capManager.getOrgClientCount('org-a')).toBe(0);
    });

    it('reads SSE_MAX_CLIENTS_PER_ORG env when no option is passed', () => {
      const prev = process.env.SSE_MAX_CLIENTS_PER_ORG;
      process.env.SSE_MAX_CLIENTS_PER_ORG = '1';
      const envManager = new SSEManager({ cleanupIntervalMs: 0 });
      try {
        expect(envManager.addClient('r1', mockSseRes(), 'org-e')).toBe(true);
        expect(envManager.addClient('r2', mockSseRes(), 'org-e')).toBe(false);
      } finally {
        envManager.shutdown();
        if (prev === undefined) delete process.env.SSE_MAX_CLIENTS_PER_ORG;
        else process.env.SSE_MAX_CLIENTS_PER_ORG = prev;
      }
    });
  });

  describe('createTicket / consumeTicket', () => {
    // Two distinct, format-valid stream subjects the ticket can be bound to.
    const REQ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const REQ_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    it('mints a ticket and consumes it exactly once (single-use)', async () => {
      const result = await manager.createTicket('org-a', REQ_A);
      expect(result.ok).toBe(true);
      const ticket = (result as { ok: true; ticket: string }).ticket;
      expect(typeof ticket).toBe('string');
      expect(ticket.length).toBeGreaterThan(0);

      // First consume (for the bound subject) returns the bound org.
      expect(await manager.consumeTicket(ticket, REQ_A)).toEqual({ orgId: 'org-a' });
      // Replay of the same value fails — it was consumed.
      expect(await manager.consumeTicket(ticket, REQ_A)).toBeNull();
    });

    it('rejects consuming a ticket for a subject it was not minted for', async () => {
      const ticket = ((await manager.createTicket('org-a', REQ_A)) as { ok: true; ticket: string }).ticket;
      // Ticket is bound to REQ_A; presenting it for REQ_B is rejected...
      expect(await manager.consumeTicket(ticket, REQ_B)).toBeNull();
      // ...and the mismatched attempt still CONSUMED the ticket (single-use),
      // so a subsequent correct-subject attempt also fails.
      expect(await manager.consumeTicket(ticket, REQ_A)).toBeNull();
    });

    it('matches the bound subject regardless of dash formatting', async () => {
      // Minted with dashes; the nginx `$request_id` form drops them. Same id.
      const ticket = ((await manager.createTicket('org-a', REQ_A)) as { ok: true; ticket: string }).ticket;
      const undashed = REQ_A.replace(/-/g, '');
      expect(await manager.consumeTicket(ticket, undashed)).toEqual({ orgId: 'org-a' });
    });

    it('returns null for an unknown ticket', async () => {
      expect(await manager.consumeTicket('never-issued', REQ_A)).toBeNull();
    });

    it('returns null for an expired ticket', async () => {
      const expiring = new SSEManager({ ticketTtlMs: -1, cleanupIntervalMs: 0 });
      try {
        const result = await expiring.createTicket('org-a', REQ_A);
        const ticket = (result as { ok: true; ticket: string }).ticket;
        // Already expired at mint (negative TTL) — consume rejects it.
        expect(await expiring.consumeTicket(ticket, REQ_A)).toBeNull();
      } finally {
        expiring.shutdown();
      }
    });

    it('enforces the per-org ticket cap (org-limit)', async () => {
      const capped = new SSEManager({ maxTicketsPerOrg: 2, cleanupIntervalMs: 0 });
      try {
        expect((await capped.createTicket('org-a', REQ_A)).ok).toBe(true);
        expect((await capped.createTicket('org-a', REQ_A)).ok).toBe(true);
        const third = await capped.createTicket('org-a', REQ_A);
        expect(third).toEqual({ ok: false, reason: 'org-limit' });
        // A different org is unaffected.
        expect((await capped.createTicket('org-b', REQ_A)).ok).toBe(true);
      } finally {
        capped.shutdown();
      }
    });

    it('enforces the total ticket cap (capacity)', async () => {
      const capped = new SSEManager({ maxTotalTickets: 1, maxTicketsPerOrg: 100, cleanupIntervalMs: 0 });
      try {
        expect((await capped.createTicket('org-a', REQ_A)).ok).toBe(true);
        const second = await capped.createTicket('org-b', REQ_A);
        expect(second).toEqual({ ok: false, reason: 'capacity' });
      } finally {
        capped.shutdown();
      }
    });

    it('refuses to mint for an org that does not OWN a bound stream subject (forbidden)', async () => {
      // The producer binds REQ_A to org-a; org-b then cannot mint a ticket for it.
      await manager.bindStreamOwner(REQ_A, 'org-a');
      expect(await manager.createTicket('org-b', REQ_A)).toEqual({ ok: false, reason: 'forbidden' });
      // The owning org still mints fine.
      expect((await manager.createTicket('org-a', REQ_A)).ok).toBe(true);
    });

    it('mints normally when no owner is bound (backward-compatible)', async () => {
      // No bindStreamOwner call → falls back to binding the ticket to the caller.
      expect((await manager.createTicket('org-x', REQ_B)).ok).toBe(true);
    });

    it('normalizes orgId so a producer/consumer casing drift does not false-forbid the owner', async () => {
      // Producer binds with one casing; the real owner mints with another. Both
      // sides normalize (trim+lowercase), so ownership still matches — no
      // spurious 'forbidden'. A genuinely different org is still refused.
      await manager.bindStreamOwner(REQ_A, 'Org-A');
      expect((await manager.createTicket('  org-a  ', REQ_A)).ok).toBe(true);
      expect(await manager.createTicket('org-b', REQ_A)).toEqual({ ok: false, reason: 'forbidden' });
    });
  });

  describe('middleware ticket gating', () => {
    // A valid requestId matching the middleware's strict 32-hex format.
    const REQ_ID = '12345678-1234-1234-1234-123456789abc';

    function mockMwRes() {
      const res: any = {
        writtenData: [] as string[],
        ended: false,
        statusCode: 200,
        flushed: false,
        headers: {} as Record<string, string>,
        status(code: number) { res.statusCode = code; return res; },
        setHeader(name: string, value: string) { res.headers[name] = value; },
        write(data: string) { res.writtenData.push(data); return true; },
        end(data?: string) { if (data) res.writtenData.push(data); res.ended = true; return res; },
        flushHeaders() { res.flushed = true; },
        on(event: string, handler: () => void) { if (event === 'close') res._closeHandler = handler; },
        _closeHandler: null as (() => void) | null,
      };
      return res;
    }

    it('rejects an anonymous subscribe with no ticket (401)', async () => {
      const res = mockMwRes();
      await manager.middleware()({ params: { requestId: REQ_ID }, query: {} }, res);
      expect(res.statusCode).toBe(401);
      expect(res.flushed).toBe(false);
      expect(manager.getClientCount(REQ_ID)).toBe(0);
    });

    it('rejects an invalid ticket (401)', async () => {
      const res = mockMwRes();
      await manager.middleware()({ params: { requestId: REQ_ID }, query: { ticket: 'bogus' } }, res);
      expect(res.statusCode).toBe(401);
      expect(manager.getClientCount(REQ_ID)).toBe(0);
    });

    it('rejects an expired ticket (401)', async () => {
      const expiring = new SSEManager({ ticketTtlMs: -1, cleanupIntervalMs: 0 });
      try {
        const ticket = ((await expiring.createTicket('org-a', REQ_ID)) as { ok: true; ticket: string }).ticket;
        const res = mockMwRes();
        await expiring.middleware()({ params: { requestId: REQ_ID }, query: { ticket } }, res);
        expect(res.statusCode).toBe(401);
        expect(expiring.getClientCount(REQ_ID)).toBe(0);
      } finally {
        expiring.shutdown();
      }
    });

    it('rejects a ticket presented for a different subject than it was minted for (401)', async () => {
      // Ticket minted for REQ_ID, but the attacker tries to open a DIFFERENT
      // stream subject they only guessed. consumeTicket rejects the mismatch,
      // so no headers flush and no client is attached to the other subject.
      const otherReqId = '87654321-4321-4321-4321-cba987654321';
      const ticket = ((await manager.createTicket('org-a', REQ_ID)) as { ok: true; ticket: string }).ticket;
      const res = mockMwRes();
      await manager.middleware()({ params: { requestId: otherReqId }, query: { ticket } }, res);
      expect(res.statusCode).toBe(401);
      expect(res.flushed).toBe(false);
      expect(manager.getClientCount(otherReqId)).toBe(0);
      // Single-use: the mismatched attempt consumed the ticket, so even the
      // correct subject can no longer use it.
      const res2 = mockMwRes();
      await manager.middleware()({ params: { requestId: REQ_ID }, query: { ticket } }, res2);
      expect(res2.statusCode).toBe(401);
      expect(manager.getClientCount(REQ_ID)).toBe(0);
    });

    it('admits a valid ticket exactly once, then it is consumed (401 on reuse)', async () => {
      const ticket = ((await manager.createTicket('org-a', REQ_ID)) as { ok: true; ticket: string }).ticket;

      // First use: stream opens, headers flush, client is bound to the org.
      const res1 = mockMwRes();
      await manager.middleware()({ params: { requestId: REQ_ID }, query: { ticket } }, res1);
      expect(res1.statusCode).toBe(200);
      expect(res1.flushed).toBe(true);
      expect(res1.headers['Content-Type']).toBe('text/event-stream');
      expect(manager.getClientCount(REQ_ID)).toBe(1);
      expect(manager.getOrgClientCount('org-a')).toBe(1);

      // Second use of the same ticket: rejected (single-use).
      const res2 = mockMwRes();
      await manager.middleware()({ params: { requestId: REQ_ID }, query: { ticket } }, res2);
      expect(res2.statusCode).toBe(401);
      expect(manager.getClientCount(REQ_ID)).toBe(1);
    });

    it('enforces the per-org connection cap on the stream (429)', async () => {
      const capped = new SSEManager({ maxClientsPerOrg: 1, maxClientsPerRequest: 100, cleanupIntervalMs: 0 });
      try {
        const REQ_ID_2 = '87654321-1234-1234-1234-123456789abc';
        const t1 = ((await capped.createTicket('org-a', REQ_ID)) as { ok: true; ticket: string }).ticket;
        // Second ticket is bound to the second subject so it passes the subject
        // check and reaches the per-org cap gate.
        const t2 = ((await capped.createTicket('org-a', REQ_ID_2)) as { ok: true; ticket: string }).ticket;

        const res1 = mockMwRes();
        await capped.middleware()({ params: { requestId: REQ_ID }, query: { ticket: t1 } }, res1);
        expect(res1.statusCode).toBe(200);
        expect(capped.getOrgClientCount('org-a')).toBe(1);

        // Second stream for the same org is over cap → 429 before headers flush.
        const res2 = mockMwRes();
        await capped.middleware()({ params: { requestId: REQ_ID_2 }, query: { ticket: t2 } }, res2);
        expect(res2.statusCode).toBe(429);
        expect(res2.flushed).toBe(false);
      } finally {
        capped.shutdown();
      }
    });

    it('closes the dangling response when addClient is rejected after headers flush', async () => {
      // The middleware pre-flight checks per-request + per-org caps but NOT the
      // process-wide total-clients cap; addClient enforces that one. Fill the
      // total cap with an anonymous client, then open a ticketed stream: the
      // pre-flight passes, headers flush (200), but addClient returns false, so
      // the middleware must end the dangling response and attach no client.
      const capped = new SSEManager({
        maxTotalClients: 1,
        maxClientsPerRequest: 100,
        maxClientsPerOrg: 100,
        cleanupIntervalMs: 0,
      });
      try {
        // Occupy the single total slot with an anonymous (no-org) client.
        expect(capped.addClient('99999999-9999-9999-9999-999999999999', mockMwRes())).toBe(true);

        const ticket = ((await capped.createTicket('org-a', REQ_ID)) as { ok: true; ticket: string }).ticket;
        const res = mockMwRes();
        await capped.middleware()({ params: { requestId: REQ_ID }, query: { ticket } }, res);

        // Headers flushed (past the caps pre-flight) but the add was rejected.
        expect(res.flushed).toBe(true);
        expect(res.ended).toBe(true);
        expect(capped.getClientCount(REQ_ID)).toBe(0);
        // The org counter was never incremented for the rejected add.
        expect(capped.getOrgClientCount('org-a')).toBe(0);
      } finally {
        capped.shutdown();
      }
    });

    it('rejects a malformed requestId before consuming the ticket (400)', async () => {
      const ticket = ((await manager.createTicket('org-a', REQ_ID)) as { ok: true; ticket: string }).ticket;
      const res = mockMwRes();
      await manager.middleware()({ params: { requestId: 'not-a-uuid' }, query: { ticket } }, res);
      expect(res.statusCode).toBe(400);
      // Ticket was NOT consumed (format check runs first) — still usable.
      expect(await manager.consumeTicket(ticket, REQ_ID)).toEqual({ orgId: 'org-a' });
    });
  });
});
