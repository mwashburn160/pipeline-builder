// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the entitlement gate on the USER subscribe route (POST /).
 *
 * Subscribing to a curated-library rule (tagged `set:standard` / `set:advanced`)
 * requires the matching plan feature on the caller's JWT; baseline/un-tagged
 * published rules stay open; sysadmins bypass. A denial records `authz.denied`.
 */

import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const subscribeMock = jest.fn(async (..._args: unknown[]) => ({ id: 'sub-1', isActive: false }));
const findPublishedByIdMock = jest.fn<(id: string) => Promise<unknown>>(async () => null);
const emitComplianceAuditMock = jest.fn<AnyFn>();
const recordMock = jest.fn<AnyFn>();

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
  sendError: jest.fn((res: any, status: number, msg: string, code: string) => res.status(status).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
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
  complianceRuleService: { findPublishedById: (...a: unknown[]) => findPublishedByIdMock(...(a as [string])) },
}));

jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: { subscribe: (...args: unknown[]) => subscribeMock(...args) },
  CS_RULE_NOT_FOUND: 'CS_RULE_NOT_FOUND',
  CS_SUBSCRIPTION_NOT_FOUND: 'CS_SUBSCRIPTION_NOT_FOUND',
  CS_NOT_PUBLISHED: 'CS_NOT_PUBLISHED',
  CS_SYSTEM_ORG: 'CS_SYSTEM_ORG',
}));

const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js');

function getPostRoot() {
  const router = createSubscriptionRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.post);
  if (!layer) throw new Error('no POST /');
  // The withRoute handler is the LAST layer in the chain — a route's own
  // middleware (permission gate, `audited(...)` declaration) comes first.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const RULE_ID = '11111111-1111-4111-8111-111111111111';

function call(user: any, originalUrl = '/compliance/subscriptions') {
  const handler = getPostRoot();
  const { res, status, json } = makeRes();
  return handler({ __orgId: 'org-a', method: 'POST', originalUrl, body: { ruleId: RULE_ID }, user } as any, res)
    .then(() => ({ status, json }));
}

describe('POST / subscribe — entitlement gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findPublishedByIdMock.mockResolvedValue(null);
  });

  it('403s a set:standard subscribe WITHOUT compliance_standard', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:standard'] });
    const { status, json } = await call({ sub: 'u-1', email: 'u1@x.com', features: [] });
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(subscribeMock).not.toHaveBeenCalled();
    // Denial is audited.
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.denied', details: expect.objectContaining({ required: 'feature:compliance_standard' }) }),
      'compliance',
    );
  });

  it('audits the denial through the shared api-core sink with the query string stripped', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:standard'] });
    await call({ sub: 'u-1', email: 'u1@x.com', organizationId: 'org-a', features: [] }, '/compliance/subscriptions?token=s3cr3t');
    expect(recordMock).toHaveBeenCalledTimes(1);
    const [event, service] = recordMock.mock.calls[0] as [any, string];
    expect(service).toBe('compliance');
    expect(event).toEqual(expect.objectContaining({
      action: 'authz.denied',
      actorId: 'u-1',
      orgId: 'org-a',
      outcome: 'failure',
      details: { method: 'POST', path: '/compliance/subscriptions', required: 'feature:compliance_standard' },
    }));
    expect(JSON.stringify(event)).not.toContain('s3cr3t');
  });

  it('allows a set:standard subscribe WITH compliance_standard', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:standard'] });
    const { status } = await call({ sub: 'u-1', features: ['compliance_standard'] });
    expect(status).toHaveBeenCalledWith(201);
    expect(subscribeMock).toHaveBeenCalledWith('org-a', RULE_ID, 'u-1');
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.toggle', targetId: RULE_ID, details: { subscribed: true, set: 'standard' },
    }));
  });

  it('403s a set:advanced subscribe when the caller only has standard', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await call({ sub: 'u-1', features: ['compliance_standard'] });
    expect(status).toHaveBeenCalledWith(403);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('allows a set:advanced subscribe WITH compliance_advanced', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await call({ sub: 'u-1', features: ['compliance_advanced'] });
    expect(status).toHaveBeenCalledWith(201);
    expect(subscribeMock).toHaveBeenCalled();
  });

  it('sysadmin bypasses the gate', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['set:advanced'] });
    const { status } = await call({ sub: 'admin', isSuperAdmin: true, features: [] });
    expect(status).toHaveBeenCalledWith(201);
    expect(subscribeMock).toHaveBeenCalled();
  });

  it('leaves baseline (un-tagged) published rules open', async () => {
    findPublishedByIdMock.mockResolvedValue({ id: RULE_ID, tags: ['quality'] });
    const { status } = await call({ sub: 'u-1', features: [] });
    expect(status).toHaveBeenCalledWith(201);
    expect(subscribeMock).toHaveBeenCalled();
    // No set-tag → no toggle audit.
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
