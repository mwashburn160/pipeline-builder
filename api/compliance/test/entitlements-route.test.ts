// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the machine `PUT /entitlements/:orgId` route.
 *
 * Verifies:
 *  - a NON service-principal / non-sysadmin caller is 403'd and the reconcile
 *    never runs (service-principal-gated, identical to reporting's retention-sync)
 *  - a service principal drives `syncEntitledSets` with the clamped set list and
 *    audits the genuine posture changes (activated/deactivated) as
 *    `compliance.rule.toggle`
 *  - a system-admin is also accepted
 *  - unknown set names are filtered out before the reconcile
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const syncEntitledSetsMock = jest.fn<(...a: unknown[]) => Promise<{ activated: string[]; deactivated: string[] }>>(
  async () => ({ activated: [], deactivated: [] }),
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
  sendBadRequest: jest.fn((res: any, msg: string, code: string) => res.status(400).json({ message: msg, code })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) => res.status(status).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, statusCode: status, data })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: '', userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: { syncEntitledSets: (...a: unknown[]) => syncEntitledSetsMock(...a) },
  KNOWN_CONTENT_SETS: ['standard', 'advanced'],
}));

const { createEntitlementSyncRoutes } = await import('../src/routes/entitlements.js');

function getPutHandler() {
  const router = createEntitlementSyncRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/:orgId' && l.route?.methods?.put);
  if (!layer) throw new Error('no PUT /:orgId');
  return layer.route.stack[0].handle;
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
    const handler = getPutHandler();
    const { res, status, json } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'u-1' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('accepts a service principal, reconciles, and audits genuine changes', async () => {
    isSvc = true;
    syncEntitledSetsMock.mockResolvedValueOnce({ activated: ['r1', 'r2'], deactivated: ['r3'] });
    const handler = getPutHandler();
    const { res, status, json } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard', 'advanced'] }, user: { sub: 'service:billing' } } as any, res);

    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard', 'advanced'], 'service:billing');
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

  it('accepts a system admin', async () => {
    isAdmin = true;
    const handler = getPutHandler();
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'admin-1' } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard'], 'admin-1');
  });

  it('filters unknown set names before reconciling', async () => {
    isSvc = true;
    const handler = getPutHandler();
    const { res } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard', 'bogus', 'advanced'] }, user: { sub: 'service:billing' } } as any, res);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard', 'advanced'], 'service:billing');
  });
});
