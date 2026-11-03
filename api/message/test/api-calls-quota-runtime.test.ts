// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RUNTIME apiCalls quota enforcement through the REAL `/messages` mount.
 *
 * The route-coverage test only trusts route-gate TAGS: a router that
 * authenticated some other way could show "checked" while the deferred check
 * `apiCallsQuota` arms is never run. That matters most here — every message
 * router authenticates PER ROUTE (its own `createAuthenticatedWithOrgRoute`), not
 * at the mount. This suite drives real HTTP through the
 * real `createApp` + `mountRoutes` with a real ES256 user token, so the check
 * runs only if api-core `requireAuth` actually fires it. Only the handler's
 * data access (`messageService.findDeleted`, spied on the real singleton) and
 * the quota client are doubled.
 */

import http from 'node:http';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import type { QuotaService, SseTicketStore } from '@pipeline-builder/api-core';
import { type AnyFn, installTestJwks, signTestUserToken, testUserIdentityClaims } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'api-calls-quota-runtime-test-secret';
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;
// Observe every request on its own: no per-pod check cache (a denied reading
// would otherwise carry into the next test) and no increment batching. Set
// before api-server loads, which reads them at import.
process.env.QUOTA_CHECK_CACHE_TTL_MS = '0';
process.env.QUOTA_CHECK_DENIED_CACHE_MS = '0';
process.env.QUOTA_INCREMENT_FLUSH_MS = '0';

const ORG = 'org-quota-1';
const usage = { used: 0, limit: 100 };
const quotaService = {
  check: jest.fn(async () => ({
    allowed: usage.used < usage.limit,
    limit: usage.limit,
    used: usage.used,
    remaining: Math.max(0, usage.limit - usage.used),
    resetAt: '2099-01-01T00:00:00.000Z',
    unlimited: false,
  })),
  increment: jest.fn(async () => undefined),
  incrementMetered: jest.fn(async (_org: string, _type: string, _auth: string, groups: Array<{ amount: number }>) =>
    ({ counted: groups.reduce((n, g) => n + g.amount, 0), overshoot: 0 })),
  reserve: jest.fn<AnyFn>(),
  decrement: jest.fn(async () => undefined),
  getTier: jest.fn(async () => 'developer' as const),
  getTierStrict: jest.fn(async () => 'developer' as const),
} as unknown as QuotaService & Record<'check' | 'increment' | 'incrementMetered', jest.Mock<AnyFn>>;

const jwks = installTestJwks();
const { createApp, attachRequestContext } = await import('@pipeline-builder/api-server');
const { createEnvSseTicketStore, SSE_TICKET_TTL_MS } = await import('@pipeline-builder/api-core');
const { messageService } = await import('../src/services/message-service.js');
const { mountRoutes } = await import('../src/app-routes.js');

// The handler's only data access: a spy proves whether the route was reached.
// Re-armed per test — the suite config restores spies between tests.
let findDeleted: jest.SpiedFunction<typeof messageService.findDeleted>;

let server: http.Server;
let baseUrl: string;
let ticketStore: SseTicketStore;

beforeAll(async () => {
  // Boot order of src/index.ts: request context, then the route mounts.
  const { app, sseManager } = createApp({ enableOpenApi: false });
  app.use(attachRequestContext(sseManager));
  ticketStore = createEnvSseTicketStore({ ttlMs: SSE_TICKET_TTL_MS, maxTotal: 10, maxPerOrg: 2 });
  mountRoutes(app, { quotaService, sseManager, ticketStore });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  ticketStore?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  usage.used = 0;
  findDeleted = jest.spyOn(messageService, 'findDeleted').mockResolvedValue([]);
});

function userToken(): string {
  return signTestUserToken({
    ...testUserIdentityClaims(),
    sub: 'user-1',
    role: 'member',
    organizationId: ORG,
    permissions: ['messages:read'],
  }, { key: jwks.primary });
}

async function listDeleted() {
  const res = await fetch(`${baseUrl}/messages/deleted`, { headers: { authorization: `Bearer ${userToken()}` } });
  return { status: res.status, json: await res.json() as any };
}

/** apiCalls units metered for the org, whichever client method carried them. */
function meteredUnits(): number {
  const single = quotaService.increment.mock.calls
    .filter(([org, type]) => org === ORG && type === 'apiCalls')
    .reduce((n, call) => n + ((call[3] as number | undefined) ?? 1), 0);
  const batched = quotaService.incrementMetered.mock.calls
    .filter(([org, type]) => org === ORG && type === 'apiCalls')
    .reduce((n, call) => n + (call[3] as Array<{ amount: number }>).reduce((m, g) => m + g.amount, 0), 0);
  return single + batched;
}

/** The meter fires on response `finish`, after the client has the body: poll for it. */
async function waitForMeteredUnits(expected: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (meteredUnits() < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return meteredUnits();
}

/** Long enough for a `finish` listener (and an unbatched send) to have run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('message apiCalls quota at runtime', () => {
  it('refuses an org at its apiCalls limit with 429 QUOTA_EXCEEDED before the handler runs', async () => {
    usage.used = usage.limit;

    const res = await listDeleted();

    expect(res.status).toBe(429);
    expect(res.json.code).toBe('QUOTA_EXCEEDED');
    expect(quotaService.check).toHaveBeenCalledWith(ORG, 'apiCalls', expect.any(String));
    expect(findDeleted).not.toHaveBeenCalled();
    await settle();
    expect(meteredUnits()).toBe(0);
  });

  it('serves an org under its limit and meters one apiCall for it', async () => {
    const res = await listDeleted();

    expect(res.status).toBe(200);
    expect(findDeleted).toHaveBeenCalledWith(ORG, expect.anything());
    expect(await waitForMeteredUnits(1)).toBe(1);
  });
});
