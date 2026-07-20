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
const bulkSetActiveMock = jest.fn(async () => 1);

// The permission set carried by the current fake request. Mutated per-test.
let currentPermissions: string[] = [];

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
  // Real semantics: a caller holds the permission only if it's in their set.
  userHasPermission: (_req: any, perm: string) => currentPermissions.includes(perm),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) =>
    res.status(status).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  isServicePrincipal: () => true,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
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
  complianceRuleService: {},
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: {
    setActive: (...args: unknown[]) => setActiveMock(...args),
    bulkSetActive: (...args: unknown[]) => bulkSetActiveMock(...args),
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
  return layer.route.stack[0].handle;
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
    currentPermissions = [];
  });

  it('lets a member WITHOUT compliance:write ACTIVATE (200)', async () => {
    currentPermissions = []; // plain member
    setActiveMock.mockResolvedValueOnce({ id: 'sub-1', isActive: true } as never);
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { ruleId: RULE_ID }, body: { isActive: true }, user: { permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(setActiveMock).toHaveBeenCalledWith('org-a', RULE_ID, true, 'u-1');
  });

  it('403s a member WITHOUT compliance:write on DEACTIVATE', async () => {
    currentPermissions = []; // plain member
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status, json } = makeRes();
    await handler({ __orgId: 'org-a', params: { ruleId: RULE_ID }, body: { isActive: false }, user: { permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    // Org-scoped service must not run when the gate rejects.
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it('lets a caller WITH compliance:write DEACTIVATE (200)', async () => {
    currentPermissions = ['compliance:write'];
    const handler = getHandler('/:ruleId', 'patch');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { ruleId: RULE_ID }, body: { isActive: false }, user: { permissions: ['compliance:write'] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(setActiveMock).toHaveBeenCalledWith('org-a', RULE_ID, false, 'u-1');
  });
});

describe('POST /bulk — deactivate requires compliance:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPermissions = [];
  });

  it('lets a member WITHOUT compliance:write bulk-ACTIVATE (200)', async () => {
    currentPermissions = [];
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleIds: [RULE_ID], isActive: true }, user: { permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(bulkSetActiveMock).toHaveBeenCalledWith('org-a', [RULE_ID], true, 'u-1');
  });

  it('403s a member WITHOUT compliance:write on bulk-DEACTIVATE (batch rejected)', async () => {
    currentPermissions = [];
    const handler = getHandler('/bulk', 'post');
    const { res, status, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleIds: [RULE_ID], isActive: false }, user: { permissions: [] } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(bulkSetActiveMock).not.toHaveBeenCalled();
  });

  it('lets a caller WITH compliance:write bulk-DEACTIVATE (200)', async () => {
    currentPermissions = ['compliance:write'];
    const handler = getHandler('/bulk', 'post');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', body: { ruleIds: [RULE_ID], isActive: false }, user: { permissions: ['compliance:write'] } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(bulkSetActiveMock).toHaveBeenCalledWith('org-a', [RULE_ID], false, 'u-1');
  });
});
