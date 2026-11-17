// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Malformed ids answer 400 VALIDATION_ERROR, never a 500.
 *
 * Regression: every compliance id column is a Postgres `uuid`, and these routes
 * handed a path id (or a list filter) straight to the query, so `/scans/abc`
 * came back as a uuid-cast 500. Each route now checks the id up front, and the
 * services below THROW if reached — a 400 here proves no query ran.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const reached = jest.fn<AnyFn>(() => {
  throw new Error('service reached with a malformed id');
});
/** Every service method a route under test could call. */
const unreachable = new Proxy({}, { get: () => reached });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    const r = schema.safeParse(req.body);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: 'invalid body' };
  },
  validateQuery: (req: any, schema: any) => {
    const r = schema.safeParse(req.query);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: 'invalid query' };
  },
  sendBadRequest: jest.fn((res: any, message: string, code: string) => res.status(400).json({ message, code })),
  sendEntityNotFound: jest.fn((res: any) => res.status(404).json({})),
  sendPaginatedNested: jest.fn((res: any) => res.status(200).json({})),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: 'org-a', userId: 'u-1' });
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
jest.unstable_mockModule('../src/helpers/exemption-rule-check.js', () => ({ checkExemptionRules: reached }));
jest.unstable_mockModule('../src/services/compliance-exemption-service.js', () => ({
  complianceExemptionService: unreachable,
  CE_NOT_FOUND: 'CE_NOT_FOUND',
  CE_SELF_APPROVE: 'CE_SELF_APPROVE',
  CE_ALREADY_EXISTS: 'CE_ALREADY_EXISTS',
  CE_NOT_EXTENDABLE: 'CE_NOT_EXTENDABLE',
  CE_EXPIRY_NOT_LATER: 'CE_EXPIRY_NOT_LATER',
}));
jest.unstable_mockModule('../src/services/compliance-scan-service.js', () => ({ complianceScanService: unreachable }));
jest.unstable_mockModule('../src/services/compliance-scan-schedule-service.js', () => ({ complianceScanScheduleService: unreachable }));
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({ complianceRuleService: unreachable }));
jest.unstable_mockModule('../src/services/subscription-service.js', () => ({ subscriptionService: unreachable }));

const { createExemptionRoutes } = await import('../src/routes/exemptions.js');
const { createScanRoutes } = await import('../src/routes/scans.js');
const { createScanScheduleRoutes } = await import('../src/routes/scan-schedules.js');
const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js');
const { isUuid } = await import('../src/helpers/uuid-param.js');

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

function handlerOf(router: any, method: Method, path: string) {
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(router: any, method: Method, path: string, req: Record<string, unknown>) {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  await handlerOf(router, method, path)({ params: {}, query: {}, body: {}, headers: {}, ...req }, { status, json });
  return { status, body: json.mock.calls[0]?.[0] as { code?: string; message?: string } | undefined };
}

const BAD = 'not-a-uuid';

beforeEach(() => {
  reached.mockClear();
});

describe('isUuid', () => {
  it('accepts a uuid and refuses anything else', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid(BAD)).toBe(false);
    expect(isUuid("1' OR '1'='1")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

const PATH_CASES: Array<[string, () => any, Method, string, string, Record<string, unknown>]> = [
  ['exemptions', createExemptionRoutes, 'put', '/:id/review', 'id', { status: 'approved' }],
  ['exemptions', createExemptionRoutes, 'put', '/:id/expiry', 'id', { expiresAt: '2099-01-01T00:00:00.000Z' }],
  ['exemptions', createExemptionRoutes, 'delete', '/:id', 'id', {}],
  ['scans', createScanRoutes, 'get', '/:id', 'id', {}],
  ['scans', createScanRoutes, 'post', '/:id/cancel', 'id', {}],
  ['scan-schedules', createScanScheduleRoutes, 'put', '/:id', 'id', { target: 'plugin' }],
  ['scan-schedules', createScanScheduleRoutes, 'patch', '/:id/active', 'id', { isActive: true }],
  ['scan-schedules', createScanScheduleRoutes, 'delete', '/:id', 'id', {}],
  ['subscriptions', createSubscriptionRoutes, 'patch', '/:ruleId', 'ruleId', { isActive: true }],
  ['subscriptions', createSubscriptionRoutes, 'post', '/:ruleId/pin', 'ruleId', {}],
  ['subscriptions', createSubscriptionRoutes, 'delete', '/:ruleId/pin', 'ruleId', {}],
  ['subscriptions', createSubscriptionRoutes, 'delete', '/:ruleId', 'ruleId', {}],
];

describe('a malformed path id is a 400 VALIDATION_ERROR, before any query', () => {
  it.each(PATH_CASES)('%s %s %s', async (_area, make, method, path, key, body) => {
    const { status, body: sent } = await call(make(), method, path, { params: { [key]: BAD }, body });
    expect(status).toHaveBeenCalledWith(400);
    expect(sent?.code).toBe('VALIDATION_ERROR');
    expect(sent?.message).toBe(`${key} must be a UUID`);
    expect(reached).not.toHaveBeenCalled();
  });
});

describe('GET /exemptions — filter validation', () => {
  it.each([
    ['ruleId', { ruleId: BAD }],
    ['entityId', { entityId: BAD }],
    ['entityType', { entityType: 'spaceship' }],
    ['status', { status: 'exploded' }],
  ])('400s a malformed %s before any query', async (_field, query) => {
    const { status, body } = await call(createExemptionRoutes(), 'get', '/', { query });
    expect(status).toHaveBeenCalledWith(400);
    expect(body?.code).toBe('VALIDATION_ERROR');
    expect(reached).not.toHaveBeenCalled();
  });

  it('passes well-formed filters through to the service', async () => {
    reached.mockImplementationOnce(async () => ({ exemptions: [], total: 0 }));
    const query = {
      ruleId: '11111111-1111-4111-8111-111111111111',
      entityId: '22222222-2222-4222-8222-222222222222',
      entityType: 'plugin',
      status: 'approved',
    };
    const { status } = await call(createExemptionRoutes(), 'get', '/', { query });
    expect(status).toHaveBeenCalledWith(200);
    expect(reached).toHaveBeenCalledWith(query, 'org-a', 25, 0);
  });
});
