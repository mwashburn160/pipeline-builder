// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for quota write routes (PUT/POST /quotas/*).
 *
 * Middleware (requireAuth, authorizeOrg) is mocked to pass through
 * those are tested separately in authorize-org.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule, MOCK_TIER_NAMES, mockIsValidTier } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mocks  must be defined before imports
const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();
const mockSendQuotaExceeded = jest.fn<AnyFn>();
const mockGetParam = jest.fn((params: Record<string, string>, key: string) => params[key]);
const mockIsSystemAdmin = jest.fn<AnyFn>().mockReturnValue(false);

class MockAppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'AppError';
  }
}

class MockNotFoundError extends MockAppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

class MockValidationError extends MockAppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitQuotaAudit,
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  sendQuotaExceeded: mockSendQuotaExceeded,
  isSystemAdmin: mockIsSystemAdmin,
  AppError: MockAppError,
  NotFoundError: MockNotFoundError,
  ValidationError: MockValidationError,
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  getParam: mockGetParam,
  DEFAULT_TIER: 'developer',
  // The REAL list, not a sample of it: a short stub here silently rejects any
  // type the suite does not already use, and the refusal reads as a route bug
  // rather than as a stale double (it cost one debugging round on `cpuCredits`).
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls', 'automationCalls', 'aiCalls', 'storageBytes', 'cpuCredits', 'dashboards'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
  QUOTA_TIERS: {
    developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } },
    pro: { limits: { plugins: 500, pipelines: 50, apiCalls: -1 } },
    unlimited: { limits: { plugins: -1, pipelines: -1, apiCalls: -1 } },
  },
  VALID_TIERS: [...MOCK_TIER_NAMES],
  isValidTier: mockIsValidTier,
  getTierLimits: (t: string) => ({
    developer: { plugins: 100, pipelines: 10, apiCalls: -1 },
    pro: { plugins: 500, pipelines: 50, apiCalls: -1 },
    unlimited: { plugins: -1, pipelines: -1, apiCalls: -1 },
  } as Record<string, any>)[t],
  validateBody: jest.fn((req: any, schema: any) => {
    try {
      const value = schema.parse(req.body);
      return { ok: true, value };
    } catch (err: any) {
      const firstIssue = err.issues?.[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      return { ok: false, error: message };
    }
  }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
    mockSendError(res, 400, msg, code);
  }),
}));

const mockIncCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  withRoute: (handler: any, opts?: any) => async (req: any, res: any) => {
    const orgId = req.user?.organizationId || '';
    const requireOrgId = opts?.requireOrgId !== false;
    if (requireOrgId && !orgId) {
      mockSendError(res, 400, 'Organization ID is required. Please provide x-org-id header.', 'VALIDATION_ERROR');
      return;
    }
    const ctx = {
      identity: { orgId, userId: req.user?.sub },
      log: jest.fn<AnyFn>(),
    };
    try {
      await handler({ req, res, ctx, orgId, userId: req.user?.sub || '' });
    } catch (err: any) {
      if (err.statusCode && err.code) {
        mockSendError(res, err.statusCode, err.message, err.code);
      } else {
        mockSendError(res, 500, err.message || 'Internal server error');
      }
    }
  },
}));

jest.unstable_mockModule('../src/middleware/authorize-org.js', () => ({
  authorizeOrg: () => (_req: any, _res: any, next: any) => next(),
  // Internal-only gate on increment/decrement — passes through here; its real
  // behaviour (service principal / sysadmin only) is covered in
  // authorize-org.test.ts.
  requireInternalCaller: (_req: any, _res: any, next: any) => next(),
}));

const mockFindById = jest.fn<AnyFn>();
const mockFindOneAndUpdate = jest.fn<AnyFn>();
const mockUpdateOne = jest.fn<AnyFn>();
const mockDeleteOne = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: {
    findById: mockFindById,
    findOneAndUpdate: mockFindOneAndUpdate,
    updateOne: mockUpdateOne,
    deleteOne: mockDeleteOne,
  },
}));

const mockEmitQuotaAudit = jest.fn<AnyFn>();

// Org → team hierarchy: stub as flat so the shared-root-cap pre-check in
// incrementUsage short-circuits (no DB walk). Hierarchy logic is covered by
// its own helper tests; these route tests stay focused on per-org increment.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  findOrgWithHierarchy: async () => ({ self: null, hasChildren: false }),
  resolveRootOrgId: async (id: string) => id,
  expandOrgScope: async (id: string) => [id],
  // Only consulted on the pooled-resolution FAILURE path (quota-service
  // decides deny-vs-per-org from it); these suites never reach it.
  getParentOrgId: async () => undefined,
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: {
    quota: {
      defaults: { plugins: 100, pipelines: 10, apiCalls: -1 },
      resetDays: 3,
    },
  },
}));

// Ledger + notices are fire-and-forget side effects of the counter routes;
// spied here so the route tests can assert WHAT was recorded.
const mockRecordUsageEvent = jest.fn<AnyFn>();
const mockRecordUsage = jest.fn<AnyFn>();
const mockNotifyThresholds = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/usage-ledger.js', () => ({ recordUsageEvent: mockRecordUsageEvent, recordUsage: mockRecordUsage }));
jest.unstable_mockModule('../src/services/threshold-notifier.js', () => ({ notifyThresholds: mockNotifyThresholds }));
// The optional AI controls (per-member share, token budget) — their own logic is
// covered in ai-controls.test.ts; here only the route's handling of a refusal.
const mockCheckAiControls = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/services/ai-controls.js', () => ({ checkAiControls: mockCheckAiControls }));

const { createUpdateQuotaRoutes, splitMeteredGroups } = await import('../src/routes/update-quota.js');
const updateQuotaRouter = createUpdateQuotaRoutes();

// Helpers

function mockReq(overrides: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, headers: {}, body: {}, user: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  res.setHeader = jest.fn<AnyFn>();
  return res;
}

/** Extract the final handler for a route (skipping middleware). */
function getHandler(method: string, path: string) {
  const layer = (updateQuotaRouter as any).stack.find( (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const futureDate = new Date(Date.now() + 86400000 * 7);

function makeSaveableOrg(overrides: Partial<any> = {}) {
  const org: any = {
    _id: 'org-123',
    name: 'Test Org',
    slug: 'test-org',
    tier: 'developer',
    quotas: { plugins: 100, pipelines: 10, apiCalls: -1 },
    usage: {
      plugins: { used: 5, resetAt: futureDate },
      pipelines: { used: 2, resetAt: futureDate },
      apiCalls: { used: 50, resetAt: futureDate },
    },
    save: jest.fn<AnyFn>().mockResolvedValue(undefined),
    ...overrides,
  };
  return org;
}

// Tests  PUT /quotas/:orgId

describe('PUT /quotas/:orgId (update org)', () => {
  const handler = getHandler('put', '/:orgId');

  beforeEach(() => { jest.clearAllMocks(); });

  it('updates org name and slug', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { name: 'New Name', slug: 'new-name' },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(org.name).toBe('New Name');
    expect(org.slug).toBe('new-name');
    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      expect.objectContaining({ quota: expect.any(Object) }),
      'Updated successfully',
    );
  });

  it('updates tier and applies tier defaults', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { tier: 'pro' },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(org.tier).toBe('pro');
    expect(org.quotas.plugins).toBe(500);
    expect(org.quotas.pipelines).toBe(50);
    expect(org.save).toHaveBeenCalled();
  });

  it('rejects a tier write to a TEAM org with 400 (tier is pooled at the root)', async () => {
    const org = { ...makeSaveableOrg(), parentOrgId: 'root-1' };
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'team-1' }, body: { tier: 'pro' }, user: { organizationId: 'team-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('is a team'), 'VALIDATION_ERROR');
    expect(org.save).not.toHaveBeenCalled();
    expect(org.tier).toBe('developer');
  });

  it('rejects a quota-limit write to a TEAM org with 400', async () => {
    const org = { ...makeSaveableOrg(), parentOrgId: 'root-1' };
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'team-1' }, body: { quotas: { plugins: 5 } }, user: { organizationId: 'team-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.stringContaining('pooled at its root'), 'VALIDATION_ERROR');
    expect(org.save).not.toHaveBeenCalled();
  });

  it('still allows a name-only edit on a TEAM org', async () => {
    const org = { ...makeSaveableOrg(), parentOrgId: 'root-1' };
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'team-1' }, body: { name: 'Renamed' }, user: { organizationId: 'team-1' } });
    const res = mockRes();
    await handler(req, res);

    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalled();
  });

  it('returns 404 when org not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { name: 'Test' },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });

  it('returns 400 for invalid body (empty)', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 500 on database error', async () => {
    mockFindById.mockRejectedValue(new Error('DB error'));

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { name: 'Test' },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

// Tests  POST /quotas/:orgId/reset

/**
 * Run a route's middleware chain after authentication: the gates and the
 * handler. `requireAuth` is skipped because this suite mocks it as a factory
 * (token verification has its own tests); `requireInternalService` is the
 * REAL gate (api-core/testing's withInternalServiceGate).
 */
async function runChain(method: string, path: string, req: any, res: any) {
  const layer = (updateQuotaRouter as any).stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  for (const { handle } of layer.route.stack.slice(1)) {
    let advanced = false;
    await handle(req, res, () => { advanced = true; });
    if (!advanced) return;
  }
}

// Billing → quota entitlement sync. Billing has no system-org session or MFA and
// mints its token for the TARGET org, so it cannot use the staff PUT above.
describe('PUT /quotas/entitlement-sync/:orgId (internal, billing only)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const billing = { organizationId: 'org-123', principalType: 'service', sub: 'service:billing' };

  it('applies billing\'s tier sync and audits it FOR the target org, not the system org', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);
    const res = mockRes();
    await runChain('put', '/entitlement-sync/:orgId', mockReq({ params: { orgId: 'org-123' }, body: { tier: 'pro' }, user: billing }), res);

    expect(org.tier).toBe('pro');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({ quota: expect.any(Object) }), 'Updated successfully');
    expect(mockEmitQuotaAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quota.limit.update', orgId: 'org-123', affectedOrgId: 'org-123', details: expect.objectContaining({ tier: 'pro' }),
    }));
  });

  it('refuses every user token, even a system-org superadmin\'s', async () => {
    const res = mockRes();
    await runChain('put', '/entitlement-sync/:orgId', mockReq({
      params: { orgId: 'org-123' },
      body: { tier: 'enterprise' },
      user: { organizationId: 'system', sub: 'user-1', isSuperAdmin: true, principalType: 'user' },
    }), res);
    expect(mockSendError).toHaveBeenCalledWith(res, 403, 'Internal service calls only', 'INSUFFICIENT_PERMISSIONS');
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSendSuccess).not.toHaveBeenCalled();
  });

  it('refuses another internal service', async () => {
    const res = mockRes();
    await runChain('put', '/entitlement-sync/:orgId', mockReq({
      params: { orgId: 'org-123' },
      body: { tier: 'enterprise' },
      user: { organizationId: 'org-123', principalType: 'service', sub: 'service:platform' },
    }), res);
    expect(mockSendError).toHaveBeenCalledWith(res, 403, 'Internal service calls only', 'INSUFFICIENT_PERMISSIONS');
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSendSuccess).not.toHaveBeenCalled();
  });

  it('keeps the staff route recording the system org as the actor\'s org', async () => {
    mockFindById.mockResolvedValue(makeSaveableOrg());
    const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
    await getHandler('put', '/:orgId')(mockReq({ params: { orgId: 'org-123' }, body: { tier: 'pro' }, user: { organizationId: SYSTEM_ORG_ID, sub: 'staff-1' } }), mockRes());
    expect(mockEmitQuotaAudit).toHaveBeenCalledWith(expect.objectContaining({ orgId: SYSTEM_ORG_ID, affectedOrgId: 'org-123' }));
  });
});

describe('POST /quotas/:orgId/reset', () => {
  const handler = getHandler('post', '/:orgId/reset');

  beforeEach(() => { jest.clearAllMocks(); });

  it('resets all quota usage when no quotaType specified', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(org.usage.plugins.used).toBe(0);
    expect(org.usage.pipelines.used).toBe(0);
    expect(org.usage.apiCalls.used).toBe(0);
    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      expect.objectContaining({ quota: expect.any(Object) }),
      'All quota usage reset successfully',
    );
  });

  it('resets specific quota type', async () => {
    const org = makeSaveableOrg();
    mockFindById.mockResolvedValue(org);

    const req = mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'plugins' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(org.usage.plugins.used).toBe(0);
    expect(org.save).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      expect.any(Object),
      'plugins usage reset successfully',
    );
  });

  it('returns 404 when org not found', async () => {
    mockFindById.mockResolvedValue(null);

    const req = mockReq({ params: { orgId: 'missing' }, body: {}, user: { organizationId: 'missing' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });

  it('returns 400 for invalid quotaType', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'invalid' }, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 500 on database error', async () => {
    mockFindById.mockRejectedValue(new Error('DB error'));

    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });
});

// Tests  DELETE /quotas/:orgId

describe('DELETE /quotas/:orgId', () => {
  const handler = getHandler('delete', '/:orgId');

  beforeEach(() => { jest.clearAllMocks(); });

  it('deletes the quota doc and emits an attributed cross-tenant quota.delete audit', async () => {
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

    const req = mockReq({
      params: { orgId: 'org-123' },
      user: { organizationId: 'sys-org', sub: 'admin-1' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockDeleteOne).toHaveBeenCalled();
    expect(mockEmitQuotaAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitQuotaAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'quota.delete',
        actorId: 'admin-1',
        affectedOrgId: 'org-123',
        details: expect.objectContaining({ deleted: true }),
      }),
    );
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200, { deleted: true }, 'Quota org deleted',
    );
  });

  it('records actorId "system" for a system-initiated delete (no authenticated user)', async () => {
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

    const req = mockReq({
      params: { orgId: 'org-123' },
      user: { organizationId: 'sys-org' }, // no sub → system-initiated
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockEmitQuotaAudit).toHaveBeenCalledTimes(1);
    expect(mockEmitQuotaAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'quota.delete',
        actorId: 'system',
      }),
    );
  });

  it('does NOT emit an audit event on the idempotent no-op (already absent)', async () => {
    mockDeleteOne.mockResolvedValue({ deletedCount: 0 });

    const req = mockReq({
      params: { orgId: 'org-gone' },
      user: { organizationId: 'sys-org', sub: 'admin-1' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockEmitQuotaAudit).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(
      res, 200, { deleted: false }, 'Quota org was already absent',
    );
  });
});

// Tests  POST /quotas/:orgId/increment — METERED batch (meter: true)

describe('POST /quotas/:orgId/increment (metered batch)', () => {
  const incrementMetered = jest.fn<AnyFn>();
  const meterRouter = createUpdateQuotaRoutes({ incrementMetered } as any);
  const layer = (meterRouter as any).stack.find((l: any) => l.route?.path === '/:orgId/increment' && l.route?.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  beforeEach(() => { jest.clearAllMocks(); });

  it('applies the sum with partial admission, never 429s, and ledgers counted vs overshoot per group', async () => {
    const resetAt = futureDate.toISOString();
    incrementMetered.mockResolvedValue({
      exceeded: false,
      rootOrgId: 'root-1',
      counted: 5,
      overshoot: 2,
      quota: { type: 'apiCalls', limit: 100, used: 100, remaining: 0, resetAt },
    });
    const a = { principalType: 'user', principalId: 'u1' };
    const b = { principalType: 'service_account', principalId: 'sa1' };
    const req = mockReq({
      params: { orgId: 'team-1' },
      user: { organizationId: 'team-1' },
      body: { quotaType: 'apiCalls', amount: 7, meter: true, groups: [{ amount: 4, attribution: a }, { amount: 3, attribution: b }] },
    });
    const res = mockRes();
    await handler(req, res);

    expect(incrementMetered).toHaveBeenCalledWith('team-1', 'apiCalls', 7);
    expect(mockSendQuotaExceeded).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({ counted: 5, overshoot: 2 }), 'Usage metered');
    expect(mockRecordUsage).toHaveBeenCalledWith([
      { orgId: 'team-1', rootOrgId: 'root-1', quotaType: 'apiCalls', amount: 4, outcome: 'counted', attribution: a },
      { orgId: 'team-1', rootOrgId: 'root-1', quotaType: 'apiCalls', amount: 1, outcome: 'counted', attribution: b },
      { orgId: 'team-1', rootOrgId: 'root-1', quotaType: 'apiCalls', amount: 2, outcome: 'overshoot', attribution: b },
    ]);
    // Notices see only what was COUNTED.
    expect(mockNotifyThresholds).toHaveBeenCalledWith(expect.objectContaining({ rootOrgId: 'root-1', amount: 5, used: 100, limit: 100 }));
    // …and the units PAST the cap get a series of their own, by amount.
    expect(mockIncCounter).toHaveBeenCalledWith('quota_overshoot_total', { type: 'apiCalls' }, 2);
  });

  it('counts overshoot as a series an ALERT can see, not only as ledger rows', async () => {
    // The per-org rows already carry route/principal/feature; what was missing
    // was something alertable. It matters most for `cpuCredits`: build admission
    // is a CHECK rather than a reservation, so concurrent submissions at the cap
    // can each overshoot by their own cost. That exposure is bounded and in the
    // tenant's favour, so it is MEASURED rather than prevented — and this is the
    // measurement.
    incrementMetered.mockResolvedValue({
      exceeded: false,
      rootOrgId: 'root-1',
      counted: 0,
      overshoot: 45,
      quota: { type: 'cpuCredits', limit: 4500, used: 4500, remaining: 0, resetAt: futureDate.toISOString() },
    });
    await handler(mockReq({
      params: { orgId: 'team-1' },
      user: { organizationId: 'team-1' },
      body: { quotaType: 'cpuCredits', amount: 45, meter: true, groups: [{ amount: 45 }] },
    }), mockRes());

    expect(mockIncCounter).toHaveBeenCalledWith('quota_overshoot_total', { type: 'cpuCredits' }, 45);
  });

  it('emits nothing when everything fit, so a quiet series means no overshoot', async () => {
    incrementMetered.mockResolvedValue({
      exceeded: false,
      rootOrgId: 'root-1',
      counted: 10,
      overshoot: 0,
      quota: { type: 'apiCalls', limit: 100, used: 10, remaining: 90, resetAt: futureDate.toISOString() },
    });
    await handler(mockReq({
      params: { orgId: 'team-1' },
      user: { organizationId: 'team-1' },
      body: { quotaType: 'apiCalls', amount: 10, meter: true, groups: [{ amount: 10 }] },
    }), mockRes());

    expect(mockIncCounter).not.toHaveBeenCalledWith('quota_overshoot_total', expect.anything(), expect.anything());
  });

  it('rejects groups that do not sum to amount, and groups without meter', async () => {
    for (const body of [
      { quotaType: 'apiCalls', amount: 5, meter: true, groups: [{ amount: 4 }] },
      { quotaType: 'apiCalls', amount: 4, groups: [{ amount: 4 }] },
      { quotaType: 'apiCalls', amount: 5000 }, // a reservation past the per-call ceiling
    ]) {
      await handler(mockReq({ params: { orgId: 'o' }, user: { organizationId: 'o' }, body }), mockRes());
    }
    expect(incrementMetered).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('splitMeteredGroups', () => {
  it('allocates counted units to groups in order and the rest to overshoot', () => {
    expect(splitMeteredGroups('o', 'r', 'apiCalls', [{ amount: 2 }, { amount: 2 }], 0).map((x: any) => [x.amount, x.outcome]))
      .toEqual([[2, 'overshoot'], [2, 'overshoot']]);
    expect(splitMeteredGroups('o', 'r', 'apiCalls', [{ amount: 2 }, { amount: 2 }], 4).map((x: any) => [x.amount, x.outcome]))
      .toEqual([[2, 'counted'], [2, 'counted']]);
  });
});

// Tests  POST /quotas/:orgId/increment

describe('POST /quotas/:orgId/increment', () => {
  const handler = getHandler('post', '/:orgId/increment');

  beforeEach(() => { jest.clearAllMocks(); });

  it('an AI usage REPORT records tokens under its attribution and moves no counter', async () => {
    const attribution = { principalType: 'user', principalId: 'u1', feature: 'ask', model: 'gpt-5', keySource: 'request' };
    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'aiCalls', report: true, tokensIn: 50, tokensOut: 7, attribution },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCheckAiControls).not.toHaveBeenCalled();
    expect(mockRecordUsageEvent).toHaveBeenCalledWith({
      orgId: 'org-123', rootOrgId: 'org-123', quotaType: 'aiCalls', amount: 0, outcome: 'counted', attribution, tokensIn: 50, tokensOut: 7, report: true,
    });
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { recorded: true }, 'Usage reported');
  });

  it('a report for any type but aiCalls is a 400', async () => {
    const res = mockRes();
    await handler(mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'plugins', report: true, tokensIn: 1 }, user: { organizationId: 'org-123' } }), res);
    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
    expect(mockRecordUsageEvent).not.toHaveBeenCalled();
  });

  it('an aiCalls reservation refused by an AI control answers its own 429 code, records a denial, and never touches the counter', async () => {
    const quota = { type: 'aiCalls', limit: 2, used: 2, remaining: 0, resetAt: futureDate.toISOString() };
    mockCheckAiControls.mockResolvedValueOnce({ code: 'AI_MEMBER_SHARE_EXCEEDED', message: 'share spent', quota });
    const attribution = { principalType: 'user', principalId: 'u1', feature: 'agent' };
    const res = mockRes();
    await handler(mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'aiCalls', amount: 1, attribution }, user: { organizationId: 'org-123' } }), res);
    expect(mockCheckAiControls).toHaveBeenCalledWith(expect.anything(), 'org-123', 1, attribution);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(res, 429, 'share spent', 'AI_MEMBER_SHARE_EXCEEDED', expect.objectContaining({ quota }));
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    expect(mockRecordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ quotaType: 'aiCalls', outcome: 'denied', amount: 1, attribution }));
  });

  it('the AI controls are consulted only for aiCalls reservations', async () => {
    mockFindOneAndUpdate.mockResolvedValue(makeSaveableOrg());
    await handler(mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'plugins', amount: 1 }, user: { organizationId: 'org-123' } }), mockRes());
    expect(mockCheckAiControls).not.toHaveBeenCalled();
  });

  it('increments quota usage successfully', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    const org = makeSaveableOrg({
      quotas: { plugins: 100, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 6, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 50, resetAt: futureDate },
      },
    });
    mockFindOneAndUpdate.mockResolvedValue(org);

    const attribution = { principalType: 'service_account', principalId: 'sa-1', keyId: 'key-1', route: 'GET /plugins/:id', pipelineId: 'p-9', requestId: 'r-1' };
    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1, attribution },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      expect.objectContaining({
        quota: expect.objectContaining({ type: 'plugins', limit: 100 }),
      }),
      'Usage incremented successfully',
    );
    // The ledger row carries the attribution the calling service sent.
    expect(mockRecordUsageEvent).toHaveBeenCalledWith({
      orgId: 'org-123', rootOrgId: 'org-123', quotaType: 'plugins', amount: 1, outcome: 'counted', attribution,
    });
    expect(mockNotifyThresholds).toHaveBeenCalledWith(expect.objectContaining({
      rootOrgId: 'org-123', quotaType: 'plugins', limit: 100, used: 6, amount: 1,
    }));
  });

  it('returns quota exceeded when limit reached', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    mockFindOneAndUpdate.mockResolvedValue(null);
    // Org exists but quota exceeded
    const existingOrg = makeSaveableOrg({
      quotas: { plugins: 10, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 10, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 0, resetAt: futureDate },
      },
    });
    mockFindById.mockResolvedValue(existingOrg);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendQuotaExceeded).toHaveBeenCalledWith( res,
      'plugins',
      expect.objectContaining({ type: 'plugins', limit: 10, used: 10, remaining: 0 }),
      expect.any(String),
      undefined,
      // An internal refusal: the calling service counts the user-facing denial.
      { countDenial: false },
    );
    // A denial is a ledger row even though the counter never moved.
    expect(mockRecordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', amount: 1 }));
    // ...and reports the 100% threshold (amount 0 = a refusal at the limit).
    expect(mockNotifyThresholds).toHaveBeenCalledWith(expect.objectContaining({ amount: 0, used: 10, limit: 10 }));
  });

  it('rejects a malformed attribution block (400)', async () => {
    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1, attribution: { principalType: 'robot' } },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRecordUsageEvent).not.toHaveBeenCalled();
  });

  it('returns 404 when org does not exist', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindById.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });

  it('returns 400 for missing quotaType', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 400 for invalid amount', async () => {
    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: -5 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 500 on database error', async () => {
    mockFindOneAndUpdate.mockRejectedValue(new Error('DB error'));

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'DB error');
  });

  it('bypasses quota limit for sysadmins', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    const org = makeSaveableOrg({
      quotas: { plugins: 10, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 10, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 50, resetAt: futureDate },
      },
    });
    mockFindOneAndUpdate.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    // Should succeed even though usage equals limit
    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      expect.objectContaining({
        quota: expect.objectContaining({ type: 'plugins', limit: 10 }),
      }),
      'Usage incremented successfully',
    );
    // Should NOT call updateOne (no auto-reset) or sendQuotaExceeded
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockSendQuotaExceeded).not.toHaveBeenCalled();
  });

  it('returns 404 for sysadmin bypass path when org does not exist', async () => {
    mockIsSystemAdmin.mockReturnValue(true);
    mockFindOneAndUpdate.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Organization not found.', 'NOT_FOUND');
  });
});

describe('POST /quotas/:orgId/decrement (reserve rollback)', () => {
  const handler = getHandler('post', '/:orgId/decrement');

  beforeEach(() => { jest.clearAllMocks(); });

  it('decrements quota usage successfully', async () => {
    const org = makeSaveableOrg({
      quotas: { plugins: 100, pipelines: 10, apiCalls: -1 },
      usage: {
        plugins: { used: 4, resetAt: futureDate },
        pipelines: { used: 2, resetAt: futureDate },
        apiCalls: { used: 50, resetAt: futureDate },
      },
    });
    mockFindOneAndUpdate.mockResolvedValue(org);

    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      expect.objectContaining({
        quota: expect.objectContaining({ type: 'plugins', limit: 100 }),
      }),
      'Usage decremented successfully',
    );
    expect(mockRecordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refunded', orgId: 'org-123', amount: 1 }));
  });

  it('returns 200 with quota:null when org does not exist (silent rollback)', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);

    const req = mockReq({
      params: { orgId: 'missing' },
      body: { quotaType: 'plugins', amount: 1 },
      user: { organizationId: 'missing' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith( res, 200,
      { quota: null },
      'Org not found, decrement skipped',
    );
  });

  it('returns 400 for missing quotaType', async () => {
    const req = mockReq({ params: { orgId: 'org-123' }, body: {}, user: { organizationId: 'org-123' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('returns 400 for invalid amount', async () => {
    const req = mockReq({
      params: { orgId: 'org-123' },
      body: { quotaType: 'plugins', amount: -5 },
      user: { organizationId: 'org-123' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });
});

// aiCalls at the limit — the reserve-at-limit race for ONE org. `incrementUsage`
// is replaced by a fake with the real conditional update's contract (atomic,
// all-or-nothing against the cap, interleaved by awaits), so this proves the
// ROUTE (AI-control pre-check included) adds no read-then-write gap of its own.
describe('POST /quotas/:orgId/increment — concurrent aiCalls reservations at the limit', () => {
  it('never grant more units than the limit, whatever the weights', async () => {
    const { QuotaService } = await import('../src/services/quota-service.js');
    const svc = new QuotaService();
    const limit = 10;
    const state = { used: 0 };
    const resetAt = futureDate.toISOString();
    const tick = () => new Promise((r) => setImmediate(r));
    jest.spyOn(svc, 'incrementUsage').mockImplementation(async (_org: string, _type: string, amount: number) => {
      await tick();
      const fits = state.used + amount <= limit;
      if (fits) state.used += amount;
      return { exceeded: !fits, rootOrgId: 'org-123', quota: { type: 'aiCalls', limit, used: state.used, remaining: Math.max(0, limit - state.used), resetAt } } as never;
    });
    const router = createUpdateQuotaRoutes(svc) as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/:orgId/increment' && l.route?.methods.post);
    const raceHandler = layer.route.stack[layer.route.stack.length - 1].handle;

    jest.clearAllMocks();
    const amounts = Array.from({ length: 30 }, (_, i) => 1 + (i % 3)); // model weights 1..3
    const results = await Promise.all(amounts.map(async (amount) => {
      const res = mockRes();
      await raceHandler(mockReq({ params: { orgId: 'org-123' }, body: { quotaType: 'aiCalls', amount }, user: { organizationId: 'org-123' } }), res);
      return { amount, res };
    }));
    const granted = results
      .filter(({ res }) => mockSendSuccess.mock.calls.some((c) => c[0] === res))
      .reduce((n, r) => n + r.amount, 0);
    expect(state.used).toBeLessThanOrEqual(limit);
    expect(granted).toBe(state.used);
    expect(mockSendQuotaExceeded.mock.calls.length).toBeGreaterThan(0);
  });
});
