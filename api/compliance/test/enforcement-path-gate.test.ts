// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * P0 paywall: the entitlement gate must cover EVERY path to enforcing a curated
 * (`set:standard` / `set:advanced`) published rule, not just POST /subscriptions.
 *
 * Covers:
 *  - PATCH /:ruleId activate  (deactivate stays open — tested elsewhere)
 *  - POST /bulk activate      (whole batch rejected if ANY rule is gated)
 *  - POST /clone              (gated on the SOURCE published rule's set tag)
 *  - POST /preview/impact     (gated when the source rule is set-tagged)
 *
 * In each case: no feature → 403 + `authz.denied`, with-feature → proceeds,
 * sysadmin bypasses, baseline/un-tagged rules stay open.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findPublishedByIdMock = jest.fn<(id: string) => Promise<unknown>>(async () => null);
const findManyByIdsMock = jest.fn<(ids: string[]) => Promise<unknown[]>>(async () => []);
const cloneRuleMock = jest.fn(async () => ({ id: 'clone-1' }));
const findOrgEntitiesMock = jest.fn(async () => []);
const setActiveMock = jest.fn(async () => ({ id: 'sub-1', isActive: true }));
const bulkSetActiveMock = jest.fn(async (_o: unknown, ids: string[]) => ids);
const emitComplianceAuditMock = jest.fn();
const recordMock = jest.fn();

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
  // Activate does NOT need compliance:write; grant it so only the FEATURE gate
  // is under test here (clone's requirePermission is a pass-through by default).
  userHasPermission: () => true,
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) => res.status(status).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  isServicePrincipal: () => true,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { complianceRule: {}, complianceRuleSubscription: {} },
  db: { select: jest.fn(), insert: jest.fn(), update: jest.fn() },
  drizzleCount: jest.fn(),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  and: jest.fn(), eq: jest.fn(), isNull: jest.fn(), inArray: jest.fn(), sql: jest.fn(),
}));

jest.unstable_mockModule('../src/engine/rule-engine.js', () => ({
  evaluateRules: jest.fn(() => ({ blocked: false, violations: [], warnings: [] })),
}));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: {
    findPublishedById: (...a: unknown[]) => findPublishedByIdMock(...(a as [string])),
    findManyByIds: (...a: unknown[]) => findManyByIdsMock(...(a as [string[]])),
    cloneRule: (...a: unknown[]) => cloneRuleMock(...(a as [])),
    findOrgEntitiesForTarget: (...a: unknown[]) => findOrgEntitiesMock(...(a as [])),
  },
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: recordMock }),
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: {
    setActive: (...a: unknown[]) => setActiveMock(...(a as [])),
    bulkSetActive: (...a: unknown[]) => bulkSetActiveMock(...(a as [unknown, string[]])),
  },
  CS_RULE_NOT_FOUND: 'CS_RULE_NOT_FOUND',
  CS_SUBSCRIPTION_NOT_FOUND: 'CS_SUBSCRIPTION_NOT_FOUND',
  CS_NOT_PUBLISHED: 'CS_NOT_PUBLISHED',
  CS_SYSTEM_ORG: 'CS_SYSTEM_ORG',
}));

const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js');

function handlerFor(method: 'patch' | 'post', path: string) {
  const router = createSubscriptionRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  // The withRoute handler is always the LAST layer (any auth middleware precedes it).
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const RULE_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  findPublishedByIdMock.mockResolvedValue(null);
  findManyByIdsMock.mockResolvedValue([]);
});

describe('PATCH /:ruleId activate — entitlement gate', () => {
  function activate(user: any, isActive = true) {
    const handler = handlerFor('patch', '/:ruleId');
    const { res, status, json } = makeRes();
    return handler({ __orgId: 'org-a', method: 'PATCH', params: { ruleId: RULE_ID }, body: { isActive }, user } as any, res)
      .then(() => ({ status, json }));
  }

  it('403s activating a set:standard rule WITHOUT the feature', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:standard'] });
    const { status, json } = await activate({ sub: 'u-1', features: [] });
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(setActiveMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.denied', details: expect.objectContaining({ required: 'feature:compliance_standard' }) }),
      'compliance',
    );
  });

  it('allows activating a set:standard rule WITH the feature', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:standard'] });
    const { status } = await activate({ sub: 'u-1', features: ['compliance_standard'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(setActiveMock).toHaveBeenCalledWith('org-a', RULE_ID, true, 'u-1');
  });

  it('sysadmin bypasses the gate', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await activate({ sub: 'admin', isSuperAdmin: true, features: [] });
    expect(status).toHaveBeenCalledWith(200);
  });

  it('leaves DEACTIVATE ungated by the feature gate', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await activate({ sub: 'u-1', features: [] }, false);
    expect(status).toHaveBeenCalledWith(200);
    // Never looked the rule up — deactivate skips the feature gate entirely.
    expect(findPublishedByIdMock).not.toHaveBeenCalled();
  });

  it('leaves baseline (un-tagged) rules open', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['quality'] });
    const { status } = await activate({ sub: 'u-1', features: [] });
    expect(status).toHaveBeenCalledWith(200);
  });
});

describe('POST /bulk activate — entitlement gate', () => {
  const IDS = [RULE_ID, '22222222-2222-4222-8222-222222222222'];
  function bulk(user: any, isActive = true) {
    const handler = handlerFor('post', '/bulk');
    const { res, status, json } = makeRes();
    return handler({ __orgId: 'org-a', method: 'POST', body: { ruleIds: IDS, isActive }, user } as any, res)
      .then(() => ({ status, json }));
  }

  it('403s the whole batch if ANY rule is gated and unentitled', async () => {
    findManyByIdsMock.mockResolvedValue([
      { id: IDS[0], tags: [] },
      { id: IDS[1], tags: ['set:advanced'] },
    ]);
    const { status } = await bulk({ sub: 'u-1', features: ['compliance_standard'] });
    expect(status).toHaveBeenCalledWith(403);
    expect(bulkSetActiveMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.denied', details: expect.objectContaining({ required: 'feature:compliance_advanced' }) }),
      'compliance',
    );
  });

  it('allows the batch when the caller is entitled to every gated rule', async () => {
    findManyByIdsMock.mockResolvedValue([
      { id: IDS[0], tags: ['set:standard'] },
      { id: IDS[1], tags: ['set:advanced'] },
    ]);
    const { status } = await bulk({ sub: 'u-1', features: ['compliance_standard', 'compliance_advanced'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(bulkSetActiveMock).toHaveBeenCalledWith('org-a', IDS, true, 'u-1');
  });

  it('does not gate bulk DEACTIVATE', async () => {
    const { status } = await bulk({ sub: 'u-1', features: [] }, false);
    expect(status).toHaveBeenCalledWith(200);
    expect(findManyByIdsMock).not.toHaveBeenCalled();
  });
});

describe('POST /clone — entitlement gate on the source rule', () => {
  function clone(user: any) {
    const handler = handlerFor('post', '/clone');
    const { res, status, json } = makeRes();
    return handler({ __orgId: 'org-a', method: 'POST', body: { ruleId: RULE_ID }, user } as any, res)
      .then(() => ({ status, json }));
  }

  it('403s cloning a set:advanced source WITHOUT the feature', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await clone({ sub: 'u-1', features: ['compliance_standard'] });
    expect(status).toHaveBeenCalledWith(403);
    expect(cloneRuleMock).not.toHaveBeenCalled();
  });

  it('allows cloning WITH the feature', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await clone({ sub: 'u-1', features: ['compliance_advanced'] });
    expect(status).toHaveBeenCalledWith(201);
    expect(cloneRuleMock).toHaveBeenCalled();
  });

  it('leaves an un-tagged source open', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: [] });
    const { status } = await clone({ sub: 'u-1', features: [] });
    expect(status).toHaveBeenCalledWith(201);
  });
});

describe('POST /preview/impact — entitlement gate', () => {
  function preview(user: any) {
    const handler = handlerFor('post', '/preview/impact');
    const { res, status, json } = makeRes();
    return handler({ __orgId: 'org-a', method: 'POST', body: { ruleId: RULE_ID }, user } as any, res)
      .then(() => ({ status, json }));
  }

  it('403s previewing a set:standard rule WITHOUT the feature', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, target: 'plugin', tags: ['set:standard'] });
    const { status } = await preview({ sub: 'u-1', features: [] });
    expect(status).toHaveBeenCalledWith(403);
    expect(findOrgEntitiesMock).not.toHaveBeenCalled();
  });

  it('allows previewing WITH the feature (runs the impact scan)', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, name: 'r', target: 'plugin', tags: ['set:standard'] });
    const { status } = await preview({ sub: 'u-1', features: ['compliance_standard'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(findOrgEntitiesMock).toHaveBeenCalled();
  });

  it('leaves an un-tagged rule open', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, name: 'r', target: 'plugin', tags: [] });
    const { status } = await preview({ sub: 'u-1', features: [] });
    expect(status).toHaveBeenCalledWith(200);
    expect(findOrgEntitiesMock).toHaveBeenCalled();
  });
});
