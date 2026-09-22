// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the machine `PUT /entitlements/:orgId` route.
 *
 * It is an INTERNAL route (#14) — only `billing`'s own signed token passes.
 * Verifies:
 *  - a plain org user, a SYSTEM ADMIN and any other service are all 403'd and
 *    the reconcile never runs (identical to reporting's retention-sync)
 *  - the billing service principal drives `syncEntitledSets` with the clamped
 *    set list and audits the genuine posture changes (activated/deactivated) as
 *    `compliance.rule.toggle`
 *  - unknown set names are filtered out before the reconcile
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const syncEntitledSetsMock = jest.fn<(...a: unknown[]) => Promise<{ skipped: boolean; activated: string[]; deactivated: string[] }>>(
  async () => ({ skipped: false, activated: [], deactivated: [] }),
);
const emitComplianceAuditMock = jest.fn();

// Auth flags carried by the current fake request; mutated per-test.
let isSvc = false;
let isAdmin = false;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: Record<string, string>, k: string) => p[k],
  validateBody: (req: { body: unknown }, schema: { parse: (b: unknown) => unknown }) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? 'invalid' };
    }
  },
  isServicePrincipal: () => isSvc,
  isSystemAdmin: () => isAdmin,
  serviceNameOf: (claims: any) => (claims?.principalType === 'service' && typeof claims.sub === 'string'
    ? claims.sub.replace(/^service:/, '') || undefined
    : undefined),
  sendBadRequest: jest.fn((res: any, msg: string, code: string) => res.status(400).json({ message: msg, code })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) => res.status(status).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: '', userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: { syncEntitledSets: (...a: unknown[]) => syncEntitledSetsMock(...a) },
  KNOWN_CONTENT_SETS: ['standard', 'advanced'],
}));

const { createEntitlementSyncRoutes } = await import('../src/routes/entitlements.js');

/**
 * Drive the route's FULL middleware chain, not just its handler — the
 * authorization now lives in `requireInternalService` ahead of the handler, so a
 * test that reached past it would assert nothing about who may call this.
 */
function putRoute() {
  const router = createEntitlementSyncRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/:orgId' && l.route?.methods?.put);
  if (!layer) throw new Error('no PUT /:orgId');
  const stack = layer.route.stack as Array<{ handle: Function }>;
  return async (req: any, res: any) => {
    for (const l of stack) {
      let advanced = false;
      await l.handle(req, res, () => { advanced = true; });
      if (!advanced) return; // a gate short-circuited
    }
  };
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

describe('PUT /entitlements/:orgId — service-principal gated', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isSvc = false;
    isAdmin = false;
  });

  it('403s a plain org-user caller and never runs the reconcile', async () => {
    isSvc = false; isAdmin = false;
    const handler = putRoute();
    const { res, status, json } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'u-1' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('accepts a service principal, reconciles, and audits genuine changes', async () => {
    isSvc = true;
    syncEntitledSetsMock.mockResolvedValueOnce({ skipped: false, activated: ['r1', 'r2'], deactivated: ['r3'] });
    const handler = putRoute();
    const { res, status, json } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard', 'advanced'] }, user: { sub: 'service:billing', principalType: 'service' } } as any, res);

    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard', 'advanced'], 'service:billing', {});
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ok: true, activated: 2, deactivated: 1 }),
    }));
    // One toggle audit per activated + deactivated id.
    expect(emitComplianceAuditMock).toHaveBeenCalledTimes(3);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.toggle', targetId: 'r1', details: { isActive: true, source: 'entitlement-sync' },
    }));
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.toggle', targetId: 'r3', details: { isActive: false, source: 'entitlement-sync' },
    }));
  });

  it('403s a SYSTEM ADMIN too — an internal route admits no user token', async () => {
    // This leg used to accept `isSystemAdmin`. #14 closed that: billing owns
    // entitlement, and "a sufficiently privileged human" is not billing.
    isAdmin = true;
    const handler = putRoute();
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'admin-1' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('403s ANOTHER service, however valid its own token is', async () => {
    isSvc = true;
    const handler = putRoute();
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'service:compliance', principalType: 'service' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('filters unknown set names before reconciling', async () => {
    isSvc = true;
    const handler = putRoute();
    const { res } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard', 'bogus', 'advanced'] }, user: { sub: 'service:billing', principalType: 'service' } } as any, res);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard', 'advanced'], 'service:billing', {});
  });
});
