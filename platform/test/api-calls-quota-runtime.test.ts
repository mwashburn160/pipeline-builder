// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RUNTIME apiCalls quota enforcement through the REAL platform mounts.
 *
 * The route-coverage test only trusts route-gate TAGS: a router that
 * authenticated some other way could show "checked" while the deferred check
 * `platformApiCallsQuota` arms is never run. That matters most here — platform
 * authenticates PER ROUTE with its OWN `requireAuth` (middleware/auth.ts), which
 * must run `runDeferredQuotaCheck` itself. This suite drives real HTTP through
 * the real `mountApiRoutes` (on the same bare app route-coverage builds) with a
 * real platform-signed ES256 user token, so the check runs only if that
 * `requireAuth` actually fires it.
 *
 * The quota client is platform's real module-level one (middleware/quota.ts),
 * pointed at a local HTTP stub of the quota service. Doubled: the tokenVersion
 * read behind `requireAuth` (`User.findById`) and the handler's data access
 * (`userProfileService.getPreferences`), both spied on the real objects.
 */

import http from 'node:http';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import { selectLean } from './helpers/query-chain.js';

const ORG = 'org-quota-1';
const USER_ID = '64b7f0c2a1b2c3d4e5f60718';

// -- Quota service stub (spoken to by platform's REAL quota client) -----------

const usage = { used: 0, limit: 100 };
const quotaCalls: Array<{ method: string; url: string; body: string }> = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    quotaCalls.push({ method: req.method ?? '', url: req.url ?? '', body });
    const send = (data: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data })); };
    const resetAt = '2099-01-01T00:00:00.000Z';
    if (req.method === 'GET' && /^\/quotas\/[^/]+\/apiCalls$/.test(req.url ?? '')) {
      return send({
        quotaType: 'apiCalls',
        status: {
          allowed: usage.used < usage.limit,
          limit: usage.limit,
          used: usage.used,
          remaining: Math.max(0, usage.limit - usage.used),
          resetAt,
          unlimited: false,
        },
      });
    }
    if (req.method === 'POST' && /^\/quotas\/[^/]+\/increment$/.test(req.url ?? '')) {
      return send({ quota: { type: 'apiCalls', limit: usage.limit, used: usage.used + 1, remaining: usage.limit - usage.used - 1, resetAt } });
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));

// The config module reads these at import time — set them before any import of it.
process.env.JWT_SECRET ||= 'api-calls-quota-runtime-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
process.env.QUOTA_SERVICE_PORT = String((stub.address() as { port: number }).port);
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;
// Observe every request on its own: no per-pod check cache (a denied reading
// would otherwise carry into the next test) and no increment batching.
process.env.QUOTA_CHECK_CACHE_TTL_MS = '0';
process.env.QUOTA_CHECK_DENIED_CACHE_MS = '0';
process.env.QUOTA_INCREMENT_FLUSH_MS = '0';

const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();
const { signUserJwt } = await import('../src/services/token-signing/index.js');
const { User } = await import('../src/models/index.js');
const { userProfileService } = await import('../src/services/user-profile-service.js');
const { mountApiRoutes } = await import('../src/routes/mount.js');

// Re-armed per test — the suite config restores spies between tests.
let getPreferences: jest.SpiedFunction<typeof userProfileService.getPreferences>;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Platform builds its app inline in index.ts (no api-server `createApp`); the
  // same bare app route-coverage uses, with pass-through limiters (rate control,
  // never authorization).
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();
  const app = express();
  app.use(express.json());
  mountApiRoutes(app, { auth: passthrough, alertWebhook: passthrough, observability: passthrough, scim: passthrough });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(() => {
  usage.used = 0;
  quotaCalls.length = 0;
  // The session read `requireAuth` makes: a live user whose tokenVersion matches.
  jest.spyOn(User, 'findById').mockReturnValue(selectLean({ _id: USER_ID, tokenVersion: 0 }) as never);
  getPreferences = jest.spyOn(userProfileService, 'getPreferences')
    .mockResolvedValue({ favorites: [], recents: [] } as never);
});

function userToken(): Promise<string> {
  return signUserJwt({
    type: 'access',
    sub: USER_ID,
    role: 'member',
    organizationId: ORG,
    permissions: [],
    tokenVersion: 0,
    principalType: 'user',
    token_use: 'access',
    amr: ['pwd'],
    aal: 1,
    auth_time: Math.floor(Date.now() / 1000),
  }, { expiresIn: 300 });
}

async function getOwnPreferences() {
  const res = await fetch(`${baseUrl}/user/preferences`, { headers: { authorization: `Bearer ${await userToken()}` } });
  return { status: res.status, json: await res.json() as any };
}

const quotaReads = () => quotaCalls.filter((c) => c.method === 'GET' && c.url === `/quotas/${ORG}/apiCalls`);
const increments = () => quotaCalls.filter((c) => c.method === 'POST' && c.url === `/quotas/${ORG}/increment`);

/** The meter fires on response `finish`, after the client has the body: poll for its POST. */
async function waitForIncrements(expected: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (increments().length < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return increments().length;
}

/** Long enough for a `finish` listener (and an unbatched POST) to have landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('platform apiCalls quota at runtime', () => {
  it('refuses an org at its apiCalls limit with 429 QUOTA_EXCEEDED before the handler runs', async () => {
    usage.used = usage.limit;

    const res = await getOwnPreferences();

    expect(res.status).toBe(429);
    expect(res.json.code).toBe('QUOTA_EXCEEDED');
    expect(quotaReads()).toHaveLength(1);
    expect(getPreferences).not.toHaveBeenCalled();
    await settle();
    expect(increments()).toHaveLength(0);
  });

  it('serves an org under its limit and meters one apiCall for it', async () => {
    const res = await getOwnPreferences();

    expect(res.status).toBe(200);
    expect(getPreferences).toHaveBeenCalledWith(USER_ID, ORG);
    expect(await waitForIncrements(1)).toBe(1);
    expect(JSON.parse(increments()[0]!.body)).toMatchObject({ quotaType: 'apiCalls', amount: 1 });
  });
});
