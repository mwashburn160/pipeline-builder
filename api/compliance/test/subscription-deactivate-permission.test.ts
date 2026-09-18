// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the RBAC gate on DEACTIVATING an enforced rule subscription.
 *
 * Subscriptions mount at member level (per-org opt-in, not rule authoring), so
 * ACTIVATING a subscription stays member-level. But DEACTIVATING an active
 * enforced rule weakens the org's compliance posture at upload/validate time —
 * governance, not opt-in — so it requires `compliance:write`, enforced inline
 * in the route handlers (PATCH /:ruleId and POST /bulk).
 *
 * Verifies:
 * - A member WITHOUT compliance:write can ACTIVATE (isActive:true) — 200
 * - A member WITHOUT compliance:write is 403'd on DEACTIVATE (isActive:false)
 * - A caller WITH compliance:write can DEACTIVATE — 200
 * - Bulk deactivate is rejected (403) without compliance:write; bulk activate is not
 * - The org-scoped service is not invoked when the gate rejects
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const setActiveMock = jest.fn(async () => ({ id: 'sub-1', isActive: false }));
// bulkSetActive now returns the ruleIds actually toggled (see FIX #A2); the
// route iterates that array, so the mock must resolve to an array, not a count.
const bulkSetActiveMock = jest.fn(async (_orgId: string, ruleIds: string[]) => ruleIds);
const unsubscribeMock = jest.fn(async () => undefined);

const recordMock = jest.fn();

// api-core's REAL authorization gates and `authz.denied` sink, imported from
// their module files (the package-specifier mock below does not intercept these
// paths), so the route's inline gates and denial audit are exercised for real.
const { requireFeature, requirePermission } = await import('@pipeline-builder/api-core/lib/middleware/auth.js');
const { wireAuthzDenialAuditor } = await import('@pipeline-builder/api-core/lib/services/remote-audit-client.js');
wireAuthzDenialAuditor('compliance', () => ({ record: recordMock }) as any);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) =>
    res.status(status).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
  requirePermission,
  requireFeature,
  isServicePrincipal: () => true,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { complianceRule: {}, complianceRuleSubscription: {} },
  db: { select: jest.fn(), insert: jest.fn(), update: jest.fn() },
  drizzleCount: jest.fn(),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ __op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ __op: 'eq', c, v }),
  isNull: (c: unknown) => ({ __op: 'isNull', c }),
  inArray: jest.fn(),
  sql: jest.fn(),
}));

jest.unstable_mockModule('../src/engine/rule-engine.js', () => ({ evaluateRules: jest.fn() }));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  // ACTIVATE paths run the entitlement gate, which looks up the rule's set tag;
  // default to un-tagged / missing so these permission-focused tests aren't
  // paywalled (they assert the compliance:write gate, not the feature gate).
  complianceRuleService: {
    findPublishedById: async () => null,
    findManyByIds: async () => [],
  },
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: {
    setActive: (...args: unknown[]) => setActiveMock(...args),
    bulkSetActive: (...args: unknown[]) => bulkSetActiveMock(...args),
    unsubscribe: (...args: unknown[]) => unsubscribeMock(...args),
  },
  CS_RULE_NOT_FOUND: 'CS_RULE_NOT_FOUND',
  CS_SUBSCRIPTION_NOT_FOUND: 'CS_SUBSCRIPTION_NOT_FOUND',
  CS_NOT_PUBLISHED: 'CS_NOT_PUBLISHED',
  CS_SYSTEM_ORG: 'CS_SYSTEM_ORG',
}));

const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js');

function getHandler(path: string, method: 'get' | 'post' | 'patch' = 'post') {
  const router = createSubscriptionRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  // The withRoute handler is the LAST layer in the chain — a route's own
  // middleware (permission gate, `audited(...)` declaration) comes first.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const RULE_ID = '11111111-1111-4111-8111-111111111111';

describe('PATCH /:ruleId — deactivate requires compliance:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets a member WITHOUT compliance:write ACTIVATE (200)', async () => {
    setActiveMock.mockResolvedValueOnce({ id: 'sub-1', isActive: true } as never);
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { ruleId: RULE_ID }, body: { isActive: true }, method: 'PATCH', originalUrl: '/compliance/subscriptions', user: { sub: 'u-1', permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(setActiveMock).toHaveBeenCalledWith('org-a', RULE_ID, true, 'u-1');
  });

  it('403s a member WITHOUT compliance:write on DEACTIVATE', async () => {
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status, json } = makeRes();
    await handler({ __orgId: 'org-a', params: { ruleId: RULE_ID }, body: { isActive: false }, method: 'PATCH', originalUrl: '/compliance/subscriptions', user: { sub: 'u-1', permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    // Org-scoped service must not run when the gate rejects.
    expect(setActiveMock).not.toHaveBeenCalled();
    // The denial is recorded through api-core's shared authz.denied sink.
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.denied', details: expect.objectContaining({ required: 'compliance:write' }) }),
      'compliance',
    );
  });

  it('lets a caller WITH compliance:write DEACTIVATE (200)', async () => {
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { ruleId: RULE_ID }, body: { isActive: false }, method: 'PATCH', originalUrl: '/compliance/subscriptions', user: { sub: 'u-1', permissions: ['compliance:write'] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(setActiveMock).toHaveBeenCalledWith('org-a', RULE_ID, false, 'u-1');
  });
});

describe('POST /bulk — deactivate requires compliance:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lets a member WITHOUT compliance:write bulk-ACTIVATE (200)', async () => {
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleIds: [RULE_ID], isActive: true }, method: 'POST', originalUrl: '/compliance/subscriptions', user: { sub: 'u-1', permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(bulkSetActiveMock).toHaveBeenCalledWith('org-a', [RULE_ID], true, 'u-1');
  });

  it('403s a member WITHOUT compliance:write on bulk-DEACTIVATE (batch rejected)', async () => {
    const handler = getHandler('/bulk', 'post');
    const { res, status, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleIds: [RULE_ID], isActive: false }, method: 'POST', originalUrl: '/compliance/subscriptions', user: { sub: 'u-1', permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(bulkSetActiveMock).not.toHaveBeenCalled();
  });

  it('lets a caller WITH compliance:write bulk-DEACTIVATE (200)', async () => {
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleIds: [RULE_ID], isActive: false }, method: 'POST', originalUrl: '/compliance/subscriptions', user: { sub: 'u-1', permissions: ['compliance:write'] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(bulkSetActiveMock).toHaveBeenCalledWith('org-a', [RULE_ID], false, 'u-1');
  });
});

describe('DELETE /:ruleId — unsubscribe requires compliance:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Run the FULL route stack (gate middleware, then handler), as Express would. */
  async function runDelete(user: Record<string, unknown>) {
    const router = createSubscriptionRoutes();
    const layer = (router.stack as any[]).find((l) => l.route?.path === '/:ruleId' && l.route?.methods?.delete);
    if (!layer) throw new Error('no DELETE /:ruleId');
    const { res, status, json } = makeRes();
    const req = { __orgId: 'org-a', method: 'DELETE', originalUrl: `/compliance/subscriptions/${RULE_ID}`, params: { ruleId: RULE_ID }, user } as any;
    for (const { handle } of layer.route.stack as Array<{ handle: Function }>) {
      let advanced = false;
      await handle(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return { status, json };
  }

  it('403s (and audits) a member WITHOUT compliance:write — unsubscribing drops enforcement like deactivate', async () => {
    const { status, json } = await runDelete({ sub: 'u-1', organizationId: 'org-a', permissions: [] });
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(unsubscribeMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.denied', details: expect.objectContaining({ required: 'compliance:write' }) }),
      'compliance',
    );
  });

  it('lets a caller WITH compliance:write unsubscribe (200)', async () => {
    const { status } = await runDelete({ sub: 'u-1', permissions: ['compliance:write'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(unsubscribeMock).toHaveBeenCalledWith('org-a', RULE_ID, 'u-1');
  });
});
