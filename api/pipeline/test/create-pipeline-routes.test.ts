// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/create-pipeline.
 *
 * Extracts the POST / handler from the router and tests it directly
 * with mock req/res objects  no HTTP server needed.
 */

// Mocks  must be defined before imports

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCreateAsDefault = jest.fn<AnyFn>();
// The route calls createAsDefaultReportInserted, which returns {pipeline, inserted}.
// Existing tests set the resolved *pipeline* on mockCreateAsDefault, so the mock
// below wraps it; `insertedResult` controls the inserted flag (default: a fresh
// create) and the over-count test flips it to exercise the quota refund path.
let insertedResult = true;
const mockIncrement = jest.fn<AnyFn>().mockResolvedValue(undefined);
const mockReserveQuota = jest.fn<(...args: any[]) => any>().mockResolvedValue({ exceeded: false, quota: { type: 'pipelines', limit: 100, used: 1, remaining: 99 } });
const mockDecrementQuota = jest.fn<AnyFn>();
const mockSendQuotaReserveDenied = jest.fn((res: any, _t: string, r: any) => {
  if (r.unavailable) return res.status(503).json({ success: false, statusCode: 503 });
  res.status(429).json({ success: false, statusCode: 429, quota: r.quota });
});

// Plugin-contract check — resolves plugins through the DB; stubbed here
// and driven per test. The real formatter is exercised in plugin-contract-check.test.ts.
const mockFindContractViolations = jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  findPluginContractViolations: (...args: unknown[]) => mockFindContractViolations(...args),
  formatContractViolations: (v: unknown[]) => `Pipeline does not meet the contract of ${v.length} plugin step(s)`,
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    createAsDefaultReportInserted: async (...args: unknown[]) => ({
      pipeline: await mockCreateAsDefault(...args),
      inserted: insertedResult,
    }),
  },
}));

const mockEmitPipelineAudit = jest.fn<AnyFn>();

const mockValidatePipeline = jest.fn<(...args: any[]) => any>().mockResolvedValue({ blocked: false, violations: [] });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitPipelineAudit,
  ValidationError: class ValidationError extends Error {},
  extractDbError: jest.fn(() => ({})),
  resolveVisibility: jest.fn((_req: any, am?: string) => am || 'private'),
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
    const response: any = { success: true, statusCode };
    if (data !== undefined) response.data = data;
    if (message) response.message = message;
    res.status(statusCode).json(response);
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg, code });
  }),
  sendError: jest.fn((res: any, statusCode: number, msg: string, code?: string, details?: any) => {
    res.status(statusCode).json({ success: false, statusCode, message: msg, code, ...details });
  }),
  sendInternalError: jest.fn((res: any, msg: string, details?: any) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg, ...details });
  }),
  validateBody: jest.fn((req: any) => {
    if (!req.body || !req.body.project || !req.body.organization) {
      return { ok: false, error: 'project and organization are required' };
    }
    return { ok: true, value: req.body };
  }),
  PipelineCreateSchema: {},
  incrementQuota: jest.fn<AnyFn>(),
  // reserve+rollback pattern. Reserve returns "not exceeded" by
  // default; tests that exercise the over-quota path can override via
  // `mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota:... })`.
  reserveQuota: (...args: unknown[]) => mockReserveQuota(...args),
  decrementQuota: (...args: unknown[]) => mockDecrementQuota(...args),
  sendQuotaReserveDenied: (...args: unknown[]) => mockSendQuotaReserveDenied(...(args as [unknown, string, unknown])),
  createComplianceClient: jest.fn(() => ({
    validatePipeline: mockValidatePipeline,
  })),
}));

const mockSendBadRequestForRoute = jest.fn((res: any, msg: string) => {
  res.status(400).json({ success: false, statusCode: 400, message: msg });
});
const mockSendInternalErrorForRoute = jest.fn((res: any, msg: string) => {
  res.status(500).json({ success: false, statusCode: 500, message: msg });
});

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithQuotaReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withQuotaReservation: (...a: any[]) => realWithQuotaReservation(...a),
  incCounter: () => undefined,
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
  getContext: (req: any) => req.context,
  createProtectedRoute: () => [],
  createAuthenticatedWithOrgRoute: () => [],
  withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
    const ctx = req.context;
    const orgId = ctx.identity.orgId?.toLowerCase() || '';
    const userId = ctx.identity.userId || '';
    const requireOrgId = options?.requireOrgId !== false;
    if (requireOrgId && !orgId) {
      return mockSendBadRequestForRoute(res, 'Organization ID is required');
    }
    try {
      await handler({ req, res, ctx, orgId, userId });
    } catch (error: any) {
      // Mirrors the real withRoute: a typed AppError keeps its own status.
      if (typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600) {
        return res.status(error.statusCode).json({ success: false, statusCode: error.statusCode, message: error.message, code: error.code });
      }
      const msg = error instanceof Error ? error.message: String(error);
      return mockSendInternalErrorForRoute(res, msg);
    }
  },
  meterQuotaOnSuccess: (_qs: unknown, quotaType: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { meters: quotaType }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  pipelineScopeMetadata: (p: Record<string, any>) => ({ ...(p.global ?? {}), ...(p.defaults?.metadata ?? {}), ...(p.synth?.metadata ?? {}) }),
  replaceNonAlphanumeric: jest.fn((str: string, replacement: string) =>
    str.replace(/[^a-zA-Z0-9]/g, replacement),
  ),
  // Template-validator dependencies  minimal stubs that accept any input
  allowedScopeRoots: () => () => true,
  validateTemplates: () => ({ valid: true, errors: [] }),
  detectCycles: () => [],
  resolveSelfReferencing: () => ({ errors: [] }),
  tokenize: () => [],
}));

const { sendBadRequest, validateBody, ConflictError, ForbiddenError } = await import('@pipeline-builder/api-core') as any;
({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
const { createCreatePipelineRoutes } = await import('../src/routes/create-pipeline.js');

// Helpers

const mockQuotaService = {
  increment: mockIncrement,
  check: jest.fn<AnyFn>(),
  getUsage: jest.fn<AnyFn>(),
} as any;

const router = createCreatePipelineRoutes(mockQuotaService);

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find( (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  // The final layer is the withRoute business handler; any preceding layers are
  // guard middleware (e.g. requirePermission). Grab the last so the test drives
  // the handler directly without an Express `next`.
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    params: {},
    query: {},
    body: {
      project: 'my-project',
      organization: 'my-org',
      description: 'test pipeline',
    },
    headers: { authorization: 'Bearer tok' },
    context: {
      identity: { orgId: 'ORG-1', userId: 'user-1' },
      log: jest.fn<AnyFn>(),
      requestId: 'req-1',
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

// Tests

describe('POST /pipelines (create)', () => {
  const handler = getHandler('post', '/');

  beforeEach(() => { jest.clearAllMocks(); insertedResult = true; });

  it('creates a pipeline and returns 201', async () => {
    const createdPipeline = {
      id: 'uuid-1',
      project: 'my_project',
      organization: 'my_org',
      pipelineName: 'my_org-my_project-pipeline',
      visibility: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    };
    mockCreateAsDefault.mockResolvedValue(createdPipeline);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith( expect.objectContaining({
      success: true,
      statusCode: 201,
      data: expect.objectContaining({
        pipeline: expect.objectContaining({ id: 'uuid-1' }),
      }),
    }),
    );
  });

  it('returns 400 TEMPLATE_CONTRACT_VIOLATION listing each step, before reserving quota', async () => {
    const steps = [
      { path: 'synth', step: 'synth', plugin: 'cdk-synth', version: '1.0.0', missing: ['vars.branch'], invalid: [] },
      {
        path: 'stages[0].steps[0]',
        step: 'deploy/helm',
        plugin: 'helm',
        version: '2.0.0',
        missing: [],
        invalid: [{ key: 'metadata.replicas', expected: 'number', message: 'pipeline metadata.replicas must be a number, got "two"' }],
      },
    ];
    mockFindContractViolations.mockResolvedValueOnce(steps);
    const props = { synth: { plugin: { name: 'cdk-synth' } } };
    const res = mockRes();
    await handler(mockReq({ body: { project: 'my-project', organization: 'my-org', props } }), res);

    expect(mockFindContractViolations).toHaveBeenCalledWith(props, expect.any(String), undefined);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TEMPLATE_CONTRACT_VIOLATION', steps }));
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockCreateAsDefault).not.toHaveBeenCalled();
  });

  it('passes a team caller\'s parent org to the contract resolution', async () => {
    mockCreateAsDefault.mockResolvedValue({ id: 'uuid-1', visibility: 'org' });
    const props = { synth: { plugin: { name: 'cdk-synth' } } };
    await handler(mockReq({ user: { parentOrganizationId: 'parent-org' }, body: { project: 'p', organization: 'o', props } }), mockRes());
    expect(mockFindContractViolations).toHaveBeenCalledWith(props, expect.any(String), 'parent-org');
  });

  it('emits an attributed pipeline.create audit event after a successful create', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-1',
      project: 'my_project',
      organization: 'my_org',
      pipelineName: 'my_org-my_project-pipeline',
      visibility: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    await handler(mockReq(), mockRes());

    expect(mockEmitPipelineAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitPipelineAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline.create',
        actorId: 'user-1',
        orgId: 'org-1',
        targetType: 'pipeline',
        targetId: 'uuid-1',
      }),
    );
  });

  it('does NOT emit an audit event when the create is blocked / fails', async () => {
    mockValidatePipeline.mockResolvedValueOnce({
      blocked: true,
      violations: [{ message: 'nope' }],
    });

    await handler(mockReq(), mockRes());

    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('returns 400 when body validation fails', async () => {
    (validateBody as jest.Mock<AnyFn>).mockReturnValueOnce({
      ok: false,
      error: 'project is required',
    });

    const req = mockReq({ body: {} });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith(res, 'project is required', 'VALIDATION_ERROR');
  });

  it('returns 400 when project contains only special characters', async () => {
    const req = mockReq({
      body: { project: '!!!', organization: 'my-org' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith( res,
      'Project and organization must contain alphanumeric characters',
      'VALIDATION_ERROR',
    );
  });

  it('returns 400 when organization contains only special characters', async () => {
    const req = mockReq({
      body: { project: 'my-project', organization: '---' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(sendBadRequest).toHaveBeenCalledWith( res,
      'Project and organization must contain alphanumeric characters',
      'VALIDATION_ERROR',
    );
  });

  it('returns 400 when orgId is missing', async () => {
    mockCreateAsDefault.mockResolvedValue({});
    const req = mockReq({
      context: {
        identity: { orgId: '', userId: 'user-1' },
        log: jest.fn<AnyFn>(),
        requestId: 'req-1',
      },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Organization ID is required' }));
  });

  it('increments quota after successful creation', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-2',
      project: 'p',
      organization: 'o',
      pipelineName: 'pipe',
      visibility: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // reserve replaces post-hoc increment. The reserved slot is
    // implicit success  the test asserts reserve was called with the
    // right args.
    expect(mockReserveQuota).toHaveBeenCalledWith( mockQuotaService, 'org-1', 'pipelines', expect.any(String),
    );
  });

  it('refunds the reserved pipelines slot when the upsert updated an existing pipeline (inserted=false)', async () => {
    insertedResult = false;
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-upsert',
      project: 'p',
      organization: 'o',
      pipelineName: 'pipe',
      visibility: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // The upsert UPDATED an existing default (not a net-new pipeline), so the
    // reserved `pipelines` create-quota slot is given back rather than consumed.
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      mockQuotaService, 'org-1', 'pipelines', expect.any(String), expect.any(Function), 1, undefined,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 500 on service error', async () => {
    mockCreateAsDefault.mockRejectedValue(new Error('DB failure'));

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  // The upsert's ON CONFLICT branch is a WRITE to an existing row: the service
  // refuses (typed 403/409) a row the caller couldn't PUT, or a tombstone.
  it('passes the caller\'s visibility authority to the service overwrite gate', async () => {
    mockCreateAsDefault.mockResolvedValue({ id: 'uuid-1', visibility: 'org' });
    await handler(mockReq(), mockRes());
    expect(mockCreateAsDefault).toHaveBeenCalledWith(
      expect.anything(), 'user-1', 'my_project', 'my_org',
      { isSystemAdmin: false, canPublish: false },
    );
  });

  it.each([
    ['409 for a tombstone / another author\'s private pipeline', () => new ConflictError('exists'), 409],
    ['403 for a public pipeline without pipelines:publish', () => new ForbiddenError('nope'), 403],
  ])('maps a service overwrite refusal to %s, refunds quota, emits no audit', async (_label, makeErr, status) => {
    mockCreateAsDefault.mockRejectedValue((makeErr as () => Error)());
    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(mockSendInternalErrorForRoute).not.toHaveBeenCalled();
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockEmitPipelineAudit).not.toHaveBeenCalled();
  });

  it('answers 503 (not 429) when the quota service could not confirm the reservation, and never creates', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, unavailable: true, quota: { type: 'pipelines', limit: 0, used: 0, remaining: 0 } });
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockCreateAsDefault).not.toHaveBeenCalled();
  });

  it('answers 429 when the org is genuinely over its pipelines quota', async () => {
    mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'pipelines', limit: 1, used: 1, remaining: 0 } });
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockCreateAsDefault).not.toHaveBeenCalled();
  });

  it('generates pipelineName from project and org when not provided', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-3',
      project: 'my_project',
      organization: 'my_org',
      pipelineName: 'my_org-my_project-pipeline',
      visibility: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Verify the service was called with a generated pipelineName
    expect(mockCreateAsDefault).toHaveBeenCalledWith( expect.objectContaining({
      pipelineName: expect.stringContaining('pipeline'),
    }),
    expect.any(String),
    expect.any(String),
    expect.any(String),
    expect.any(Object),
    );
  });

  it('uses provided pipelineName when specified', async () => {
    mockCreateAsDefault.mockResolvedValue({
      id: 'uuid-4',
      project: 'p',
      organization: 'o',
      pipelineName: 'custom-name',
      visibility: 'private',
      isDefault: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      createdBy: 'user-1',
    });

    const req = mockReq({
      body: { project: 'p', organization: 'o', pipelineName: 'custom-name' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockCreateAsDefault).toHaveBeenCalledWith( expect.objectContaining({ pipelineName: 'custom-name' }),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  // The success message is derived from the rung the pipeline actually landed
  // on — the default `org` rung is visible to the whole org, not "Private".
  it.each([
    ['org', /accessible to organization org-1/],
    ['private', /Private pipeline created successfully \(accessible to its author only\)/],
    ['public', /Public pipeline created successfully/],
  ])('describes a %s pipeline accurately in the success message', async (visibility, expected) => {
    mockCreateAsDefault.mockResolvedValue({ id: 'uuid-v', project: 'p', organization: 'o', pipelineName: 'n', visibility });
    const res = mockRes();
    await handler(mockReq(), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.message).toMatch(expected);
    if (visibility === 'org') expect(payload.message).not.toMatch(/Private/);
  });
});
