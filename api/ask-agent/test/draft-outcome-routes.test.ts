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

const { createDraftOutcomeRoutes } = await import('../src/routes/draft-outcome.js');
const router = createDraftOutcomeRoutes();

function handler() {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/draft-outcome' && l.route?.methods.post);
  if (!layer) throw new Error('no POST /draft-outcome');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(body: unknown): any {
  return {
    body,
    headers: { authorization: 'Bearer USER-BEARER-tok' },
    context: { identity: { orgId: 'ORG-1', userId: 'user-9' }, log: jest.fn(), requestId: 'req-1' },
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
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
    await handler()(mockReq({ feature: 'pipeline-generate', outcome: 'edited_accepted' }), res);

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
    await handler()(mockReq({ feature: 'agent', outcome: 'accepted', prompt: 'secret prompt', draft: { name: 'x' }, userId: 'u-1' }), res);
    const sent = JSON.stringify(mockPost.mock.calls);
    expect(sent).not.toContain('secret prompt');
    expect(sent).not.toContain('u-1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refuses a feature or outcome outside the bounded catalogs', async () => {
    for (const body of [{ feature: 'ask', outcome: 'accepted' }, { feature: 'agent', outcome: 'meh' }, {}]) {
      const res = mockRes();
      await handler()(mockReq(body), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a quota service that is down or refuses does not fail the user\'s flow — it answers recorded: false', async () => {
    mockPost.mockResolvedValueOnce({ statusCode: 503, body: {} });
    const res1 = mockRes();
    await handler()(mockReq({ feature: 'plugin-generate', outcome: 'discarded' }), res1);
    expect(res1.json).toHaveBeenCalledWith({ success: true, data: { recorded: false } });

    mockPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res2 = mockRes();
    await handler()(mockReq({ feature: 'plugin-generate', outcome: 'discarded' }), res2);
    expect(res2.json).toHaveBeenCalledWith({ success: true, data: { recorded: false } });
    expect(mockIncCounter).toHaveBeenCalledWith('ai_draft_outcome_forward_failures_total', { reason: 'non-ok' });
    expect(mockIncCounter).toHaveBeenCalledWith('ai_draft_outcome_forward_failures_total', { reason: 'exception' });
  });
});
