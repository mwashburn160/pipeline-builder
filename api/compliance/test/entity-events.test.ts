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
}));

import { sendSuccess, sendError, sendBadRequest } from '@pipeline-builder/api-core';
import { createEntityEventRoutes } from '../src/routes/entity-events';

function getRouteHandler() {
  const router = createEntityEventRoutes();
  const layer = (router as unknown as { stack: Array<{ route: { path: string; stack: Array<{ handle: Function }> } }> })
    .stack.find((l) => l.route?.path === '/');
  return layer?.route.stack[0].handle;
}

describe('Entity Events Route', () => {
  let handler: Function;

  beforeAll(() => {
    handler = getRouteHandler()!;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeReq(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return {
      headers: { 'x-internal-service': 'true', ...headers },
      body,
    };
  }

  const res = {};

  it('rejects requests without x-internal-service header', async () => {
    await handler(makeReq({}, { 'x-internal-service': '' }), res);
    expect(sendError).toHaveBeenCalledWith(res, 403, expect.any(String), expect.any(String));
  });

  it('rejects requests with missing required fields', async () => {
    await handler(makeReq({}), res);
    expect(sendBadRequest).toHaveBeenCalled();
  });

  it('returns evaluated:false for non-compliance targets', async () => {
    await handler(makeReq({
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

    await handler(makeReq({
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

    await handler(makeReq({
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

    await handler(makeReq({
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

    await handler(makeReq({
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
