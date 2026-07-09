// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the compliance entity-events route.
 * Verifies internal service-to-service authentication, validation,
 * rule evaluation, and audit logging.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
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
  // Route uses `requireAuth` and `isServicePrincipal` as middleware. Pass
  // through to next() in the auth gate; isServicePrincipal returns true unless
  // the test sets `req.__notServicePrincipal`.
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  isServicePrincipal: (req: { __notServicePrincipal?: boolean }) => !req?.__notServicePrincipal,
}));

const mockFindActiveByOrgAndTarget = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
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
jest.unstable_mockModule('../src/engine/rule-engine.js', () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
}));

jest.unstable_mockModule('../src/helpers/audit-logger.js', () => ({
  logComplianceCheck: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  schema: {},
  db: { select: jest.fn() },
  // Route now wraps its handler in `runWithTenantContext` (so internal
  // service-to-service calls establish a tenant scope from the payload's
  // orgId before any RLS-touching service call). Pass-through is fine for
  // these tests — they don't exercise GUC behavior.
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

const { sendSuccess, sendBadRequest, sendError } = await import('@pipeline-builder/api-core');
const { createEntityEventRoutes } = await import('../src/routes/entity-events.js');

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

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('org-1', 'plugin', undefined);
    expect(mockEvaluateRules).toHaveBeenCalled();
    expect(sendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      evaluated: true,
      blocked: false,
    }));
  });

  it('threads parentOrgId from the payload into rule lookup', async () => {
    mockFindActiveByOrgAndTarget.mockResolvedValue([{ id: 'rule-1' }]);
    mockEvaluateRules.mockReturnValue({ blocked: false, violations: [], warnings: [], rulesEvaluated: 1 });

    await runRoute(makeReq({
      entityId: 'id-1',
      orgId: 'team-1',
      parentOrgId: 'root-1',
      target: 'plugin',
      eventType: 'updated',
      attributes: { name: 'my-plugin' },
    }), res);

    expect(mockFindActiveByOrgAndTarget).toHaveBeenCalledWith('team-1', 'plugin', 'root-1');
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

  it('replies 500 (not 200) on evaluation error so the caller retries — fail-closed', async () => {
    mockFindActiveByOrgAndTarget.mockRejectedValue(new Error('DB down'));

    await runRoute(makeReq({
      entityId: 'id-3',
      orgId: 'org-3',
      target: 'plugin',
      eventType: 'deleted',
    }), res);

    expect(sendError).toHaveBeenCalledWith(res, 500, expect.any(String), expect.anything());
    expect(sendSuccess).not.toHaveBeenCalled();
  });
});
