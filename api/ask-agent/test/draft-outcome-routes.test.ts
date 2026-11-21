// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /ask-agent/draft-outcome` — what a user did with one AI-generated
 * draft (accepted / edited-then-accepted / discarded), forwarded to the quota
 * service's draft-outcome counter on ask-agent's OWN service identity.
 *
 * The privacy contract is what these tests pin: the forwarded body is exactly
 * `{ quotaType, draftOutcome: { feature, outcome } }` — no user id, no prompt,
 * no draft content — and both fields are closed catalogs.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const SERVICE_TOKEN = 'Bearer ask-agent-service-token';
const mockGetServiceAuthHeader = jest.fn<AnyFn>(() => SERVICE_TOKEN);
const mockPost = jest.fn<AnyFn>();
const constructed: unknown[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: mockGetServiceAuthHeader,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  InternalHttpClient: class {
    constructor(cfg: unknown) { constructed.push(cfg); }
    post(...a: unknown[]) { return mockPost(...a); }
  },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, code: number, msg: string, errCode?: string) => res.status(code).json({ message: msg, code: errCode })),
  sendSuccess: jest.fn((res: any, code: number, data?: any) => res.status(code).json({ success: true, data })),
}));

const mockIncCounter = jest.fn<AnyFn>();
/** Options each `rateLimitByOrg` limiter was built with. */
const limiterOptions: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: Function) => async (req: any, res: any) => {
    const ctx = req.context;
    await fn({ req, res, ctx, orgId: ctx.identity.orgId?.toLowerCase() || '', userId: ctx.identity.userId || '' });
  },
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  rateLimitByOrg: (opts: Record<string, unknown>) => {
    limiterOptions.push(opts);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  observe: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { quotaHost: 'quota', quotaPort: 3000 } }) },
}));

delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;
const { createMemoryAiDraftStore, _setAiDraftStoreForTests, getAiDraftStore } = await import('@pipeline-builder/api-core');
const { createDraftOutcomeRoutes } = await import('../src/routes/draft-outcome.js');
const router = createDraftOutcomeRoutes();

function handler() {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/draft-outcome' && l.route?.methods.post);
  if (!layer) throw new Error('no POST /draft-outcome');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(body: unknown, identity: { orgId: string; userId: string } = { orgId: 'ORG-1', userId: 'user-9' }): any {
  return {
    body,
    headers: { authorization: 'Bearer USER-BEARER-tok' },
    context: { identity, log: jest.fn(), requestId: 'req-1' },
  };
}

type DraftFeature = 'agent' | 'pipeline-generate' | 'plugin-generate';
/** A draft id as a generator would have issued it for user-9 in org-1. */
async function issued(feature: DraftFeature, ref: { orgId: string; userId: string } = { orgId: 'org-1', userId: 'user-9' }): Promise<string> {
  return (await getAiDraftStore().issue({ ...ref, feature }))!;
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  _setAiDraftStoreForTests(createMemoryAiDraftStore());
  mockPost.mockResolvedValue({ statusCode: 200, body: { success: true } });
});

describe('POST /ask-agent/draft-outcome', () => {
  it('caps outcomes per USER, ahead of the handler, so one member cannot flood the acceptance rate', () => {
    expect(limiterOptions).toContainEqual(expect.objectContaining({ name: 'ask-draft-outcome', keyBy: 'user', windowMs: 60_000 }));
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/draft-outcome');
    // requireAskAccess, requireFeature, the limiter, then the handler.
    expect(layer.route.stack).toHaveLength(4);
  });

  it('forwards org, feature and outcome ONLY, on ask-agent\'s own identity — never the user\'s token or id', async () => {
    const res = mockRes();
    await handler()(mockReq({ feature: 'pipeline-generate', outcome: 'edited_accepted', draftId: await issued('pipeline-generate') }), res);

    expect(mockGetServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'ask-agent', orgId: 'org-1', role: 'member' });
    const [path, body, opts] = mockPost.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(path).toBe('/quotas/org-1/increment');
    expect(body).toEqual({ quotaType: 'aiCalls', draftOutcome: { feature: 'pipeline-generate', outcome: 'edited_accepted' } });
    expect(opts.headers).toMatchObject({ 'Authorization': SERVICE_TOKEN, 'x-org-id': 'org-1' });
    const sent = JSON.stringify(mockPost.mock.calls);
    expect(sent).not.toContain('user-9');
    expect(sent).not.toContain('USER-BEARER');
    expect(mockIncCounter).toHaveBeenCalledWith('ai_draft_outcomes_total', { feature: 'pipeline-generate', outcome: 'edited_accepted' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { recorded: true } });
  });

  it('strips anything but the two catalog fields (a prompt or draft in the body never leaves)', async () => {
    const res = mockRes();
    await handler()(mockReq({ feature: 'agent', outcome: 'accepted', draftId: await issued('agent'), prompt: 'secret prompt', draft: { name: 'x' }, userId: 'u-1' }), res);
    const sent = JSON.stringify(mockPost.mock.calls);
    expect(sent).not.toContain('secret prompt');
    expect(sent).not.toContain('u-1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refuses a feature or outcome outside the bounded catalogs', async () => {
    const draftId = await issued('agent');
    for (const body of [{ feature: 'ask', outcome: 'accepted', draftId }, { feature: 'agent', outcome: 'meh', draftId }, { feature: 'agent', outcome: 'accepted' }, {}]) {
      const res = mockRes();
      await handler()(mockReq(body), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a quota service that is down or refuses does not fail the user\'s flow — it answers recorded: false', async () => {
    mockPost.mockResolvedValueOnce({ statusCode: 503, body: {} });
    const res1 = mockRes();
    await handler()(mockReq({ feature: 'plugin-generate', outcome: 'discarded', draftId: await issued('plugin-generate') }), res1);
    expect(res1.json).toHaveBeenCalledWith({ success: true, data: { recorded: false } });

    mockPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res2 = mockRes();
    await handler()(mockReq({ feature: 'plugin-generate', outcome: 'discarded', draftId: await issued('plugin-generate') }), res2);
    expect(res2.json).toHaveBeenCalledWith({ success: true, data: { recorded: false } });
    expect(mockIncCounter).toHaveBeenCalledWith('ai_draft_outcome_forward_failures_total', { reason: 'non-ok' });
    expect(mockIncCounter).toHaveBeenCalledWith('ai_draft_outcome_forward_failures_total', { reason: 'exception' });
  });

  describe('draft ids', () => {
    const post = async (body: unknown, identity?: { orgId: string; userId: string }) => {
      const res = mockRes();
      await handler()(mockReq(body, identity), res);
      return res;
    };

    it('counts an outcome for a valid draft id exactly once; a reuse is 409 and counts nothing', async () => {
      const draftId = await issued('pipeline-generate');
      const first = await post({ feature: 'pipeline-generate', outcome: 'accepted', draftId });
      expect(first.status).toHaveBeenCalledWith(200);
      const again = await post({ feature: 'pipeline-generate', outcome: 'discarded', draftId });
      expect(again.status).toHaveBeenCalledWith(409);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('refuses another user\'s draft id (400), and it stays redeemable by its owner', async () => {
      const draftId = await issued('agent');
      const res = await post({ feature: 'agent', outcome: 'accepted', draftId }, { orgId: 'ORG-1', userId: 'user-other' });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPost).not.toHaveBeenCalled();
      expect((await post({ feature: 'agent', outcome: 'accepted', draftId })).status).toHaveBeenCalledWith(200);
    });

    it('refuses a draft id from another org, or for another feature (400)', async () => {
      const draftId = await issued('agent');
      expect((await post({ feature: 'agent', outcome: 'accepted', draftId }, { orgId: 'ORG-2', userId: 'user-9' })).status).toHaveBeenCalledWith(400);
      expect((await post({ feature: 'plugin-generate', outcome: 'accepted', draftId })).status).toHaveBeenCalledWith(400);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('refuses a forged draft id (400)', async () => {
      const res = await post({ feature: 'agent', outcome: 'accepted', draftId: 'Z'.repeat(32) });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('refuses an expired draft id (400)', async () => {
      _setAiDraftStoreForTests(createMemoryAiDraftStore({ ttlMs: 20 }));
      const draftId = await issued('agent');
      await new Promise((r) => setTimeout(r, 40));
      const res = await post({ feature: 'agent', outcome: 'accepted', draftId });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('answers 503 when the draft store cannot verify the id (fail-closed: nothing counted)', async () => {
      _setAiDraftStoreForTests({ issue: async () => null, redeem: async () => 'unavailable', stop: () => undefined });
      const res = await post({ feature: 'agent', outcome: 'accepted', draftId: 'Z'.repeat(32) });
      expect(res.status).toHaveBeenCalledWith(503);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });
});
