// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the entitlement-sync hardening on `/compliance/entitlements/:orgId`:
 *  - sync-race watermark: a push with a STALE `occurredAt` is skipped
 *    (`{ ok:true, skipped:true }`) and never reconciles; a newer one applies and
 *    advances the watermark; a push with no `occurredAt` always applies.
 *  - drift-read: `GET /:orgId` returns `{ sets }` from the active entitled sets.
 *  - the machine guard is tightened to the BILLING service principal (or
 *    sysadmin) — a generic service principal is 403'd on both legs.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const syncEntitledSetsMock = jest.fn<(...a: unknown[]) => Promise<{ skipped: boolean; activated: string[]; deactivated: string[] }>>(
  async () => ({ skipped: false, activated: [], deactivated: [] }),
);
const getActiveEntitledSetsMock = jest.fn<(orgId: string) => Promise<string[]>>(async () => []);
const getLastOccurredAtMock = jest.fn<(orgId: string) => Promise<Date | null>>(async () => null);
const recordMock = jest.fn<(orgId: string, at: Date) => Promise<void>>(async () => undefined);
const recordAuditMock = jest.fn();

let isAdmin = false;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => recordAuditMock(...a),
  getParam: (p: Record<string, string>, k: string) => p[k],
  validateBody: (req: { body: unknown }, schema: { parse: (b: unknown) => unknown }) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? 'invalid' };
    }
  },
  isSystemAdmin: () => isAdmin,
  isServicePrincipal: (req: any) => req?.user?.principalType === 'service',
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


jest.unstable_mockModule('../src/services/entitlement-watermark-store.js', () => ({
  entitlementWatermarkStore: {
    getLastOccurredAt: (...a: unknown[]) => getLastOccurredAtMock(...(a as [string])),
    record: (...a: unknown[]) => recordMock(...(a as [string, Date])),
  },
}));

jest.unstable_mockModule('../src/services/subscription-service.js', () => ({
  subscriptionService: {
    syncEntitledSets: (...a: unknown[]) => syncEntitledSetsMock(...a),
    getActiveEntitledSets: (...a: unknown[]) => getActiveEntitledSetsMock(...(a as [string])),
  },
}));

const { createEntitlementSyncRoutes } = await import('../src/routes/entitlements.js');

/**
 * Drive the route's FULL middleware chain, not just its handler — the
 * authorization lives in `requireInternalService` ahead of the handler, so
 * a test that reached past it would assert nothing about who may call this.
 */
function handlerFor(method: 'put' | 'get') {
  const router = createEntitlementSyncRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/:orgId' && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} /:orgId`);
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

const BILLING = { sub: 'service:billing', principalType: 'service' };
const T1 = '2026-08-20T10:00:00.000Z';
const T2 = '2026-08-20T12:00:00.000Z';

beforeEach(() => {
  jest.clearAllMocks();
  isAdmin = false;
  getLastOccurredAtMock.mockResolvedValue(null);
});

describe('PUT /:orgId — occurredAt watermark', () => {
  function put(body: unknown, user: any = BILLING) {
    const handler = handlerFor('put');
    const { res, status, json } = makeRes();
    return handler({ params: { orgId: 'org-a' }, body, user } as any, res).then(() => ({ status, json }));
  }

  it('hands occurredAt to the service, which checks + applies + records it in ONE locked tx', async () => {
    const { status } = await put({ sets: ['standard'], occurredAt: T2 });
    expect(status).toHaveBeenCalledWith(200);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard'], 'service:billing', { occurredAt: new Date(T2) });
    // The route itself never touches the watermark any more (no split check/record).
    expect(getLastOccurredAtMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('relays a stale skip as { ok, skipped } with NO audit', async () => {
    syncEntitledSetsMock.mockResolvedValueOnce({ skipped: true, activated: [], deactivated: [] } as never);
    const { status, json } = await put({ sets: ['advanced'], occurredAt: T1 });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ok: true, skipped: true }),
    }));
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('applies a push with NO occurredAt (no watermark option)', async () => {
    const { status } = await put({ sets: ['standard'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard'], 'service:billing', {});
  });
});

describe('entitlement legs — P3 billing-only guard', () => {
  it('403s a generic (non-billing) service principal on PUT', async () => {
    const handler = handlerFor('put');
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'service:reporting', principalType: 'service' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('403s a generic service principal on GET', async () => {
    const handler = handlerFor('get');
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, user: { sub: 'service:reporting', principalType: 'service' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(getActiveEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('403s a system admin on PUT — an internal route admits no user token', async () => {
    isAdmin = true;
    const handler = handlerFor('put');
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'admin-1' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });
});

describe('GET /:orgId — drift-read shape', () => {
  it('returns { sets } for the billing service', async () => {
    getActiveEntitledSetsMock.mockResolvedValue(['advanced', 'standard']);
    const handler = handlerFor('get');
    const { res, status, json } = makeRes();
    await handler({ params: { orgId: 'org-a' }, user: BILLING } as any, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(getActiveEntitledSetsMock).toHaveBeenCalledWith('org-a');
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: { sets: ['advanced', 'standard'] },
    }));
  });
});
