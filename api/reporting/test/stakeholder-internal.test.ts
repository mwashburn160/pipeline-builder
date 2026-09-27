// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /reports/stakeholder-internal/owner-left/:orgId/:userId`.
 *
 * The one call platform makes into reporting. It has no user, no orgId claim and
 * no feature entitlement, so everything that makes it safe is in this route:
 *
 *  - only platform's signed token reaches it;
 *  - the tenant scope for RLS is established from the PATH, since there is no JWT
 *    to take it from;
 *  - the audit actor is the SYSTEM, not the admin who clicked "deactivate" — they
 *    did not decide to stop these particular reports;
 *  - nothing is audited when nothing was paused, so a member who owned no reports
 *    leaves no misleading entry.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { routeChain } from './helpers/route-chain.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockRecordAudit = jest.fn<(event: any) => void>();
const mockSendSuccess = jest.fn((_res: any, code: number, data: any) => ({ code, data }));
const mockSendBadRequest = jest.fn((_res: any, msg: string) => ({ msg }));
const mockPause = jest.fn<AnyFn>();
/** Tenant scopes the route entered, in order. */
let scopes: Array<{ orgId?: string; isSuperAdmin?: boolean }> = [];

let internalAllowed = true;

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), identity: {}, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: '', userId: '' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: mockSendSuccess,
  sendBadRequest: mockSendBadRequest,
  recordAudit: (event: any) => mockRecordAudit(event),
  requireInternalService: (opts: { callers: string[] }) => Object.assign(
    (_req: any, res: any, next: any) => (internalAllowed ? next() : res.status(403).json({ success: false })),
    { __internalCallers: opts.callers },
  ),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  stakeholderReportStore: { pauseDefinitionsForOwner: (...a: unknown[]) => mockPause(...a) },
  runWithTenantContext: (ctx: any, fn: any) => { scopes.push(ctx); return fn(); },
}));

const { createStakeholderInternalRoutes } = await import('../src/routes/stakeholder-internal.js');

const ORG = 'acme';
const USER = 'user-lead';
const PATH = '/owner-left/:orgId/:userId';

describe('stakeholder internal routes', () => {
  let router: any;
  const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const call = (req: any = {}) => routeChain(router, PATH, 'post')(
    { params: { orgId: ORG, userId: USER }, query: {}, body: { reason: 'owner_inactive' }, headers: {}, ...req },
    res(),
  );
  const payload = () => mockSendSuccess.mock.calls[0]?.[2] as any;
  const audit = () => mockRecordAudit.mock.calls[0]?.[0] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    scopes = [];
    internalAllowed = true;
    mockPause.mockResolvedValue([]);
    router = createStakeholderInternalRoutes();
  });

  it('pauses the owner’s definitions and returns what stopped', async () => {
    mockPause.mockResolvedValue([
      { id: 'def-1', name: 'Weekly delivery', cadence: 'weekly' },
      { id: 'def-2', name: 'Monthly health', cadence: 'monthly' },
    ]);
    await call();
    expect(mockPause).toHaveBeenCalledWith(ORG, USER, 'owner_inactive');
    expect(payload().paused).toEqual([
      { id: 'def-1', name: 'Weekly delivery', cadence: 'weekly' },
      { id: 'def-2', name: 'Monthly health', cadence: 'monthly' },
    ]);
  });

  /** There is no JWT to take the tenant from, so RLS is scoped from the path. */
  it('establishes the tenant scope from the path parameter', async () => {
    await call({ params: { orgId: 'ACME', userId: USER } });
    expect(scopes).toEqual([{ orgId: 'acme', isSuperAdmin: false }]);
    expect(mockPause).toHaveBeenCalledWith('acme', USER, 'owner_inactive');
  });

  it('is reachable only by platform’s signed token', () => {
    const declared = router.stack
      .flatMap((l: any) => l.route?.stack ?? [])
      .map((l: any) => (l.handle as any).__internalCallers)
      .find(Boolean);
    expect(declared).toEqual(['platform']);
  });

  it('refuses a caller the internal gate rejects, before touching anything', async () => {
    internalAllowed = false;
    await call();
    expect(mockPause).not.toHaveBeenCalled();
  });

  /**
   * The admin who deactivated an account did not decide to stop these particular
   * reports; attributing it to them would put a decision in the trail they never
   * made.
   */
  it('attributes the pause to the system, not to a person', async () => {
    mockPause.mockResolvedValue([{ id: 'def-1', name: 'Weekly delivery', cadence: 'weekly' }]);
    await call();
    expect(audit()).toMatchObject({
      action: 'reporting.report.paused',
      actorId: 'system',
      orgId: ORG,
      affectedOrgId: ORG,
      details: { reason: 'owner_inactive', ownerId: USER, count: 1, names: ['Weekly delivery'] },
    });
  });

  it('audits nothing when the member owned no reports', async () => {
    await call();
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(payload().paused).toEqual([]);
  });

  it('accepts the permission-loss reason too', async () => {
    await call({ body: { reason: 'permission_lost' } });
    expect(mockPause).toHaveBeenCalledWith(ORG, USER, 'permission_lost');
  });

  it.each([
    ['an unknown reason', { reason: 'because' }],
    ['no reason at all', {}],
    ['an extra field', { reason: 'owner_inactive', isActive: true }],
  ])('rejects %s without pausing anything', async (_case, body) => {
    await call({ body });
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
  });

  it.each([
    ['no orgId', { orgId: '', userId: USER }],
    ['no userId', { orgId: ORG, userId: '' }],
    ['neither', {}],
  ])('rejects %s without pausing anything', async (_case, params) => {
    await call({ params });
    expect(mockSendBadRequest).toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
  });
});
