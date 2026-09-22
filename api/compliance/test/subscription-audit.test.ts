// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-accuracy tests for the subscription routes.
 *
 * FIX #A2 (audit accuracy): POST /bulk must emit `compliance.rule.toggle` ONLY
 * for the ruleIds the service ACTUALLY toggled (the array `bulkSetActive`
 * returns), never for every requested id — so posture changes aren't logged for
 * rules that weren't subscribed or didn't change.
 *
 * FIX #A4 (denial-coverage consistency): the INLINE `compliance:write` deactivate
 * denials (PATCH /:ruleId, POST /bulk) must record an `authz.denied` audit before
 * returning 403, matching gate-based (`requirePermission`) denials.
 */

import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const setActiveMock = jest.fn(async (..._args: unknown[]) => ({ id: 'sub-1', isActive: false }));
const bulkSetActiveMock = jest.fn<(...a: unknown[]) => Promise<string[]>>(async () => []);
const recordAuditMock = jest.fn<AnyFn>();
const recordMock = jest.fn<AnyFn>();

// api-core's REAL `requirePermission` gate and `authz.denied` sink, imported from
// their module files (the package-specifier mock below does not intercept these
// paths), so the inline deactivate denial audit is exercised for real.
const { requireFeature, requirePermission } = await import('@pipeline-builder/api-core/lib/middleware/permission-gates.js');
const { wireAuthzDenialAuditor } = await import('@pipeline-builder/api-core/lib/services/remote-audit-client.js');
wireAuthzDenialAuditor('compliance', () => ({ record: recordMock }) as any);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => recordAuditMock(...a),
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
  sendPaginatedNested: jest.fn<AnyFn>(),
  requirePermission,
  requireFeature,
  isServicePrincipal: () => true,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { complianceRule: {}, complianceRuleSubscription: {} },
  db: { select: jest.fn<AnyFn>(), insert: jest.fn<AnyFn>(), update: jest.fn<AnyFn>() },
  drizzleCount: jest.fn<AnyFn>(),
}));

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: jest.fn<AnyFn>(), eq: jest.fn<AnyFn>(), isNull: jest.fn<AnyFn>(), inArray: jest.fn<AnyFn>(), sql: jest.fn<AnyFn>(),
}));

jest.unstable_mockModule('../src/engine/rule-engine.js', () => ({ evaluateRules: jest.fn<AnyFn>() }));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  // The entitlement gate on ACTIVATE looks these up; default to un-tagged /
  // missing so the gate is a no-op and these audit-focused tests exercise the
  // toggle-audit path (not the paywall).
  complianceRuleService: {
    findPublishedById: async () => null,
    findManyByIds: async () => [],
  },
}));

// Spy on the per-rule toggle helper (#A2). The authz.denied record (#A4) flows
// through api-core's shared sink wired above.

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: {
    setActive: (...args: unknown[]) => setActiveMock(...args),
    bulkSetActive: (...args: unknown[]) => bulkSetActiveMock(...args),
  },
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
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const RULE_A = '11111111-1111-4111-8111-111111111111';
const RULE_B = '22222222-2222-4222-8222-222222222222';
const USER = { sub: 'u-1', email: 'u1@example.com', organizationId: 'org-a' };

describe('POST /bulk — audits toggle ONLY for affected ids (#A2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits compliance.rule.toggle only for the ruleIds the service toggled', async () => {
    // Requested two rules, but the service reports only RULE_A actually changed.
    bulkSetActiveMock.mockResolvedValueOnce([RULE_A]);
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();

    await handler({
      __orgId: 'org-a',
      method: 'POST',
      originalUrl: '/compliance/subscriptions/bulk',
      body: { ruleIds: [RULE_A, RULE_B], isActive: true },
      user: { ...USER, permissions: [] },
    } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    // Exactly one toggle event — for the affected id, with the single-toggle shape.
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.toggle',
      targetType: 'rule',
      targetId: RULE_A,
      details: { isActive: true },
    }));
    // The unaffected / never-changed id must NOT be audited.
    expect(recordAuditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetId: RULE_B }),
    );
  });

  it('emits nothing when no rows were toggled', async () => {
    bulkSetActiveMock.mockResolvedValueOnce([]);
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();

    await handler({
      __orgId: 'org-a',
      method: 'POST',
      originalUrl: '/compliance/subscriptions/bulk',
      body: { ruleIds: [RULE_A], isActive: true },
      user: { ...USER, permissions: [] },
    } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});

describe('inline compliance:write deactivate denial records authz.denied (#A4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('PATCH /:ruleId deactivate: emits authz.denied before the 403', async () => {
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status, json } = makeRes();

    await handler({
      __orgId: 'org-a',
      method: 'PATCH',
      originalUrl: '/compliance/subscriptions/' + RULE_A + '?access_token=s3cr3t',
      params: { ruleId: RULE_A },
      body: { isActive: false },
      user: { ...USER, permissions: [] },
    } as any, res);

    // 403 body/status unchanged.
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    // The denied attempt is recorded via api-core's shared sink, service principal
    // 'compliance', with the path (no query string).
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        actorId: 'u-1',
        actorEmail: 'u1@example.com',
        orgId: 'org-a',
        outcome: 'failure',
        details: { method: 'PATCH', path: '/compliance/subscriptions/' + RULE_A, required: 'compliance:write' },
      }),
      'compliance',
    );
    // The org-scoped mutation must not have run.
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it('POST /bulk deactivate: emits authz.denied before the 403', async () => {
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();

    await handler({
      __orgId: 'org-a',
      method: 'POST',
      originalUrl: '/compliance/subscriptions/bulk',
      body: { ruleIds: [RULE_A], isActive: false },
      user: { ...USER, permissions: [] },
    } as any, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'authz.denied',
        actorId: 'u-1',
        outcome: 'failure',
        details: expect.objectContaining({ method: 'POST', required: 'compliance:write' }),
      }),
      'compliance',
    );
    expect(bulkSetActiveMock).not.toHaveBeenCalled();
  });
});
