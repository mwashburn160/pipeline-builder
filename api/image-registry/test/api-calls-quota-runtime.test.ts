// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RUNTIME apiCalls quota enforcement through the REAL `/api/images` mount.
 *
 * The route-coverage test only trusts route-gate TAGS: a router that
 * authenticated some other way could show "checked" while the deferred check
 * `apiCallsQuota` arms is never run. This suite drives real HTTP through the
 * real `createApp` + `mountRoutes` with a real ES256 user token, so the check
 * runs only if api-core `requireAuth` actually fires it. Only the handler's
 * upstream (the Distribution registry client) and the quota client are doubled;
 * the caller is a system-org admin with an aal2 session, since `registry:read`
 * is system-org-only (`requireSystemOrgPermission`).
 */

import http from 'node:http';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import type { QuotaService } from '@pipeline-builder/api-core';
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
process.env.IMAGE_REGISTRY_HOST ||= 'registry.invalid';
process.env.REGISTRY_TOKEN_PRIVATE_KEY ||= 'quota-runtime-test-key';
process.env.REGISTRY_TOKEN_CERTIFICATE ||= 'quota-runtime-test-cert';

// The `/token` route's signer is not under test (same stand-in as route-coverage).
jest.unstable_mockModule('../src/services/token-service.js', () => ({
  authorizeAndIssue: jest.fn(async () => ({ token: '', accessCount: 0 })),
  parseScope: jest.fn(() => null),
}));

// The handler's upstream: a spy on the catalog call proves whether the route
// was reached. Every export is listed — the full mount loads all its importers.
const mockListRepositories = jest.fn(async () => ({ repositories: ['system/base'] }));
jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  mintRepositoryPushToken: jest.fn<AnyFn>(),
  mintRepositoryPullToken: jest.fn<AnyFn>(),
  listRepositories: mockListRepositories,
  listRepositoriesUnderPrefix: jest.fn<AnyFn>(),
  listTags: jest.fn<AnyFn>(),
  getManifest: jest.fn<AnyFn>(),
  deleteManifest: jest.fn<AnyFn>(),
  putManifest: jest.fn<AnyFn>(),
  deleteTag: jest.fn<AnyFn>(),
  uploadSmallBlob: jest.fn<AnyFn>(),
  headManifest: jest.fn<AnyFn>(),
  headBlob: jest.fn<AnyFn>(),
  getBlobStream: jest.fn<AnyFn>(),
  getBlobJson: jest.fn<AnyFn>(),
  mountBlob: jest.fn<AnyFn>(),
  isNotFound: () => false,
}));

/** The default SYSTEM_ORG_ID — `registry:read` is confined to the system org. */
const ORG = '000000000000000000000001';
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
const { mountRoutes } = await import('../src/app-routes.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Boot order of src/index.ts: request context, then the route mounts.
  const { app, sseManager } = createApp({ enableOpenApi: false });
  app.use(attachRequestContext(sseManager));
  mountRoutes(app, { quotaService });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  usage.used = 0;
});

function userToken(): string {
  return signTestUserToken({
    ...testUserIdentityClaims(),
    sub: 'user-1',
    role: 'admin',
    organizationId: ORG,
    isSuperAdmin: true,
    permissions: ['registry:read'],
    amr: ['pwd', 'mfa'],
    aal: 2,
  }, { key: jwks.primary });
}

async function listImages() {
  const res = await fetch(`${baseUrl}/api/images`, { headers: { authorization: `Bearer ${userToken()}` } });
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

describe('image-registry apiCalls quota at runtime', () => {
  it('refuses an org at its apiCalls limit with 429 QUOTA_EXCEEDED before the handler runs', async () => {
    usage.used = usage.limit;

    const res = await listImages();

    expect(res.status).toBe(429);
    expect(res.json.code).toBe('QUOTA_EXCEEDED');
    expect(quotaService.check).toHaveBeenCalledWith(ORG, 'apiCalls', expect.any(String));
    expect(mockListRepositories).not.toHaveBeenCalled();
    await settle();
    expect(meteredUnits()).toBe(0);
  });

  it('serves an org under its limit and meters one apiCall for it', async () => {
    const res = await listImages();

    expect(res.status).toBe(200);
    expect(mockListRepositories).toHaveBeenCalled();
    expect(await waitForMeteredUnits(1)).toBe(1);
  });
});
