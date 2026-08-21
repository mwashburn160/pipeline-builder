// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the entitlement-sync hardening on `/compliance/entitlements/:orgId`:
 *  - #6 sync-race watermark: a push with a STALE `occurredAt` is skipped
 *    (`{ ok:true, skipped:true }`) and never reconciles; a newer one applies and
 *    advances the watermark; a push with no `occurredAt` always applies.
 *  - #2 drift-read: `GET /:orgId` returns `{ sets }` from the active entitled sets.
 *  - P3: the machine guard is tightened to `sub === 'service:billing'` (or
 *    sysadmin) — a generic service principal is 403'd on both legs.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const syncEntitledSetsMock = jest.fn<(...a: unknown[]) => Promise<{ activated: string[]; deactivated: string[] }>>(
  async () => ({ activated: [], deactivated: [] }),
);
const getActiveEntitledSetsMock = jest.fn<(orgId: string) => Promise<string[]>>(async () => []);
const getLastOccurredAtMock = jest.fn<(orgId: string) => Promise<Date | null>>(async () => null);
const recordMock = jest.fn<(orgId: string, at: Date) => Promise<void>>(async () => undefined);
const emitComplianceAuditMock = jest.fn();

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
  KNOWN_CONTENT_SETS: ['standard', 'advanced'],
}));

const { createEntitlementSyncRoutes } = await import('../src/routes/entitlements.js');

function handlerFor(method: 'put' | 'get') {
  const router = createEntitlementSyncRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/:orgId' && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} /:orgId`);
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const BILLING = { sub: 'service:billing' };
const T1 = '2026-08-20T10:00:00.000Z';
const T2 = '2026-08-20T12:00:00.000Z';

beforeEach(() => {
  jest.clearAllMocks();
  isAdmin = false;
  getLastOccurredAtMock.mockResolvedValue(null);
});

describe('PUT /:orgId — occurredAt watermark (#6)', () => {
  function put(body: unknown, user: any = BILLING) {
    const handler = handlerFor('put');
    const { res, status, json } = makeRes();
    return handler({ params: { orgId: 'org-a' }, body, user } as any, res).then(() => ({ status, json }));
  }

  it('applies a first push (no prior watermark) and records occurredAt', async () => {
    getLastOccurredAtMock.mockResolvedValue(null);
    const { status } = await put({ sets: ['standard'], occurredAt: T2 });
    expect(status).toHaveBeenCalledWith(200);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard'], 'service:billing');
    expect(recordMock).toHaveBeenCalledWith('org-a', new Date(T2));
  });

  it('SKIPS a stale push (occurredAt <= watermark) and never reconciles', async () => {
    getLastOccurredAtMock.mockResolvedValue(new Date(T2));
    const { status, json } = await put({ sets: ['advanced'], occurredAt: T1 });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ok: true, skipped: true }),
    }));
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('SKIPS an equal-timestamp push (idempotent replay)', async () => {
    getLastOccurredAtMock.mockResolvedValue(new Date(T2));
    const { json } = await put({ sets: ['standard'], occurredAt: T2 });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ skipped: true }) }));
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('applies a newer push over an older watermark', async () => {
    getLastOccurredAtMock.mockResolvedValue(new Date(T1));
    const { status } = await put({ sets: ['standard', 'advanced'], occurredAt: T2 });
    expect(status).toHaveBeenCalledWith(200);
    expect(syncEntitledSetsMock).toHaveBeenCalledWith('org-a', ['standard', 'advanced'], 'service:billing');
    expect(recordMock).toHaveBeenCalledWith('org-a', new Date(T2));
  });

  it('applies a push with NO occurredAt without touching the watermark', async () => {
    const { status } = await put({ sets: ['standard'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(getLastOccurredAtMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(syncEntitledSetsMock).toHaveBeenCalled();
  });
});

describe('entitlement legs — P3 billing-only guard', () => {
  it('403s a generic (non-billing) service principal on PUT', async () => {
    const handler = handlerFor('put');
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'service:reporting' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(syncEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('403s a generic service principal on GET', async () => {
    const handler = handlerFor('get');
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, user: { sub: 'service:reporting' } } as any, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(getActiveEntitledSetsMock).not.toHaveBeenCalled();
  });

  it('accepts a system admin on PUT', async () => {
    isAdmin = true;
    const handler = handlerFor('put');
    const { res, status } = makeRes();
    await handler({ params: { orgId: 'org-a' }, body: { sets: ['standard'] }, user: { sub: 'admin-1' } } as any, res);
    expect(status).toHaveBeenCalledWith(200);
  });
});

describe('GET /:orgId — drift-read shape (#2)', () => {
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
