// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /ask-agent/draft-outcome` through the REAL `/ask-agent` mount: reporting
 * what became of a draft is not an Ask. It must not spend an apiCall, must not
 * be refused when the org's apiCalls ran out, and must not use up the per-org
 * Ask rate limit (`ASK_RATE_LIMIT_PER_MIN`). It keeps auth, the ai_generation
 * feature gate and its own per-user cap.
 */

import http from 'node:http';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import type { QuotaService } from '@pipeline-builder/api-core';
import {
  type AnyFn,
  installTestJwks,
  signTestUserToken,
  stubModule,
  testUserIdentityClaims,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'draft-outcome-mount-test-secret';
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;
process.env.QUOTA_CHECK_CACHE_TTL_MS = '0';
process.env.QUOTA_CHECK_DENIED_CACHE_MS = '0';
process.env.QUOTA_INCREMENT_FLUSH_MS = '0';
// One Ask per minute: any draft outcome that spent the Ask slot would make the
// GET below 429.
process.env.ASK_RATE_LIMIT_PER_MIN = '1';
// The outcome's own forward to quota goes nowhere (it answers recorded: false).
process.env.QUOTA_SERVICE_HOST = '127.0.0.1';
process.env.QUOTA_SERVICE_PORT = '1';

jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  getAvailableProviders: jest.fn<AnyFn>(() => [{ id: 'anthropic', name: 'Anthropic', models: [] }]),
  AI_REQUEST_TIMEOUT_MS: 120_000,
}));

const ORG = 'org-outcome-1';
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

/** The org's AI switch as the fake platform reports it (`GET /internal/ai/access/:orgId`). */
const aiEnabled = new Map<string, boolean>();
const platform = http.createServer((req, res) => {
  const orgId = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, data: { aiEnabled: aiEnabled.get(orgId) ?? true, providers: [] } }));
});
await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', () => resolve()));
process.env.PLATFORM_SERVICE_HOST = '127.0.0.1';
process.env.PLATFORM_SERVICE_PORT = String((platform.address() as { port: number }).port);
process.env.ORG_AI_ACCESS_TTL_MS = '0';

const jwks = installTestJwks();
const { createApp, attachRequestContext } = await import('@pipeline-builder/api-server');
const { getAiDraftStore } = await import('@pipeline-builder/api-core');
const { mountRoutes } = await import('../src/app-routes.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const { app, sseManager } = createApp({ enableOpenApi: false });
  app.use(attachRequestContext(sseManager));
  mountRoutes(app, { quotaService });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => platform.close(() => resolve()));
});

beforeEach(() => {
  usage.used = 0;
});

const token = (features = ['ai_generation']) => signTestUserToken({
  ...testUserIdentityClaims(),
  sub: 'user-1',
  role: 'member',
  organizationId: ORG,
  permissions: ['pipelines:read'],
  features,
}, { key: jwks.primary });

async function postOutcome(body: Record<string, unknown>, bearer = token()) {
  const res = await fetch(`${baseUrl}/ask-agent/draft-outcome`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

const issue = async () => (await getAiDraftStore().issue({ orgId: ORG, userId: 'user-1', feature: 'pipeline-generate' }))!;

function meteredUnits(): number {
  const single = quotaService.increment.mock.calls
    .filter(([org, type]) => org === ORG && type === 'apiCalls')
    .reduce((n, call) => n + ((call[3] as number | undefined) ?? 1), 0);
  const batched = quotaService.incrementMetered.mock.calls
    .filter(([org, type]) => org === ORG && type === 'apiCalls')
    .reduce((n, call) => n + (call[3] as Array<{ amount: number }>).reduce((m, g) => m + g.amount, 0), 0);
  return single + batched;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('POST /ask-agent/draft-outcome mount', () => {
  it('still requires auth and the ai_generation feature', async () => {
    const anon = await fetch(`${baseUrl}/ask-agent/draft-outcome`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(anon.status).toBe(401);
    const noFeature = await postOutcome({ feature: 'pipeline-generate', outcome: 'accepted', draftId: await issue() }, token([]));
    expect(noFeature.status).toBe(403);
  });

  it('is refused (403 AI_DISABLED) for an org that switched AI off, and the draft id stays unspent', async () => {
    aiEnabled.set(ORG, false);
    try {
      const draftId = await issue();
      const res = await postOutcome({ feature: 'pipeline-generate', outcome: 'accepted', draftId });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('AI_DISABLED');
      aiEnabled.set(ORG, true);
      expect((await postOutcome({ feature: 'pipeline-generate', outcome: 'accepted', draftId })).status).toBe(200);
    } finally {
      aiEnabled.delete(ORG);
    }
  });

  it('spends no apiCall and is served for an org at its apiCalls limit', async () => {
    usage.used = usage.limit;
    for (let i = 0; i < 3; i++) {
      const res = await postOutcome({ feature: 'pipeline-generate', outcome: 'accepted', draftId: await issue() });
      expect(res.status).toBe(200);
    }
    await settle();
    expect(meteredUnits()).toBe(0);
    expect(quotaService.check).not.toHaveBeenCalledWith(ORG, 'apiCalls', expect.anything());
  });

  it('uses no Ask rate-limit slot: the org\'s one Ask per minute is still there afterwards', async () => {
    const outcome = await postOutcome({ feature: 'pipeline-generate', outcome: 'discarded', draftId: await issue() });
    expect(outcome.status).toBe(200);
    const ask = await fetch(`${baseUrl}/ask-agent/providers`, { headers: { authorization: `Bearer ${token()}` } });
    expect(ask.status).toBe(200);
    // The limit is live: a second Ask in the window is refused.
    const again = await fetch(`${baseUrl}/ask-agent/providers`, { headers: { authorization: `Bearer ${token()}` } });
    expect(again.status).toBe(429);
  });
});
