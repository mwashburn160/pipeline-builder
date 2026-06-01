// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the compliance entity-events route.
 * Verifies internal service-to-service authentication, validation,
 * rule evaluation, and audit logging.
 */

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  sendSuccess: jest.fn((_res: unknown, status: number, data: unknown) => ({ status, data })),
  sendError: jest.fn((_res: unknown, status: number, msg: string) => ({ status, msg })),
  sendBadRequest: jest.fn((_res: unknown, msg: string) => ({ status: 400, msg })),
  validateBody: jest.fn((req: { body: unknown }, schema: { parse: (v: unknown) => unknown }) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Validation failed' };
    }
  }),
  ErrorCode: {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
  createCacheService: () => ({
    getOrSet: (_key: string, factory: () => Promise<unknown>) => factory(),
    invalidatePattern: () => Promise.resolve(0),
  }),
  // Route uses `requireAuth` and `isServicePrincipal` as middleware. Pass
  // through to next() in the auth gate; isServicePrincipal returns true unless
  // the test sets `req.__notServicePrincipal`.
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  isServicePrincipal: (req: { __notServicePrincipal?: boolean }) => !req?.__notServicePrincipal,
}));

const mockFindActiveByOrgAndTarget = jest.fn().mockResolvedValue([]);
jest.mock('../src/services/compliance-rule-service', () => ({
  complianceRuleService: {
    findActiveByOrgAndTarget: (...args: unknown[]) => mockFindActiveByOrgAndTarget(...args),
  },
}));

const mockEvaluateRules = jest.fn().mockReturnValue({
  blocked: false,
  violations: [],
  warnings: [],
  rulesEvaluated: 0,
});
jest.mock('../src/engine/rule-engine', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
}));

jest.mock('../src/helpers/audit-logger', () => ({
  logComplianceCheck: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  schema: {},
  db: { select: jest.fn() },
  // Route now wraps its handler in `runWithTenantContext` (so internal
  // service-to-service calls establish a tenant scope from the payload's
  // orgId before any RLS-touching service call). Pass-through is fine for
  // these tests — they don't exercise GUC behavior.
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

import { sendSuccess, sendBadRequest } from '@pipeline-builder/api-core';
import { createEntityEventRoutes } from '../src/routes/entity-events';

// The route now has three middlewares: requireAuth, requireServicePrincipal,
// final handler. Run them sequentially so the service-principal gate fires
// for the relevant test, but otherwise pass through to the handler.
// A middleware that does NOT call next() (because it sent a response) must
// resolve the chain — otherwise the test hangs to the jest timeout.
function runRoute(req: any, res: any): Promise<unknown> {
  const router = createEntityEventRoutes();
  const layer = (router as unknown as { stack: Array<{ route: { path: string; stack: Array<{ handle: Function }> } }> })
    .stack.find((l) => l.route?.path === '/')!;
  const stack = layer.route.stack.map((s) => s.handle);
  return new Promise((resolve) => {
    let i = 0;
    let settled = false;
    const finish = (v: unknown) => { if (!settled) { settled = true; resolve(v); } };
    const tick = () => {
      if (i >= stack.length || settled) return finish(undefined);
      const h = stack[i++];
      const isMiddleware = h.length >= 3;
      let advanced = false;
      const next = () => { advanced = true; tick(); };
      const result = isMiddleware ? h(req, res, next) : h(req, res);
      const done = () => { if (!advanced && !settled) finish(undefined); };
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(done, done);
      } else {
        done();
      }
    };
    tick();
  });
}

describe('Entity Events Route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeReq(body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return { headers: {}, body, ...extra };
  }

  const res = {};

  it('rejects non-service-principal callers (e.g. user JWTs)', async () => {
    await runRoute(makeReq({}, { __notServicePrincipal: true }), res);
    expect(sendBadRequest).toHaveBeenCalledWith(res, expect.any(String), 'INSUFFICIENT_PERMISSIONS');
  });

  it('rejects requests with missing required fields', async () => {
    await runRoute(makeReq({}), res);
    expect(sendBadRequest).toHaveBeenCalled();
  });

  it('returns evaluated:false for non-compliance targets', async () => {
    await runRoute(makeReq({
      entityId: 'id-1',
      orgId: 'org-1',
      target: 'user',
      eventType: 'created',
    }), res);

    expect(sendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      evaluated: false,
      reason: 'non-compliance target',
    }));
  });

  it('returns evaluated:false when no active rules exist', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([]);

    await runRoute(makeReq({
      entityId: 'id-1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'created',
      attributes: { name: 'test' },
    }), res);

    expect(sendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      evaluated: false,
      reason: 'no active rules',
    }));
  });

  it('evaluates rules for plugin target', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: false,
      violations: [],
      warnings: [],
      rulesEvaluated: 1,
    });

    await runRoute(makeReq({
      entityId: 'id-1',
      orgId: 'org-1',
      target: 'plugin',
      eventType: 'updated',
      attributes: { name: 'my-plugin' },
    }), res);

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin');
    expect(mockEvaluateRules).toHaveBeenCalled();
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      evaluated: true,
      blocked: false,
    }));
  });

  it('evaluates rules for pipeline target', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-2' }]);
    mockEvaluateRules.mockReturnValue({
      blocked: true,
      violations: [{ ruleId: 'rule-2', message: 'denied' }],
      warnings: [],
      rulesEvaluated: 1,
    });

    await runRoute(makeReq({
      entityId: 'id-2',
      orgId: 'org-2',
      target: 'pipeline',
      eventType: 'created',
      attributes: { project: 'proj' },
    }), res);

    expect(sendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      evaluated: true,
      blocked: true,
      violations: 1,
    }));
  });

  it('returns evaluated:false on evaluation error', async () => {
    mockFindActiveByOrgAndTarget.mockRejectedValue(new Error('DB down'));

    await runRoute(makeReq({
      entityId: 'id-3',
      orgId: 'org-3',
      target: 'plugin',
      eventType: 'deleted',
    }), res);

    expect(sendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      evaluated: false,
      reason: 'evaluation error',
    }));
  });
});
