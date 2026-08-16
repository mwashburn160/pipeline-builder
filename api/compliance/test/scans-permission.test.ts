// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the RBAC gate on the compliance scan MUTATIONS.
 *
 * POST /compliance/scans launches a full org-wide re-evaluation and
 * POST /compliance/scans/:id/cancel stops one — both are writes and must
 * require `compliance:write`, like every other compliance mutation. Previously
 * they were mounted auth-only (any same-org member could trigger them).
 *
 * The gate is `requirePermission('compliance:write')` mounted ahead of each
 * handler. Here `requirePermission` is mocked with real semantics (checks the
 * caller's permission set) and the whole route stack is driven so the gate runs
 * before the handler, exactly as express would.
 *
 * Reads (GET /, GET /:id) stay open and are covered elsewhere.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createMock = jest.fn(async () => ({ id: 'scan-1', target: 'all' }));
const cancelMock = jest.fn(async () => ({ id: 'scan-1', status: 'cancelled' }));
const emitComplianceAuditMock = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  validateQuery: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.query) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn((res: any) => res.status(404).json({ message: 'not found' })),
  // Real gate semantics: 403 unless the caller holds the required permission.
  requirePermission: (perm: string) => (req: any, res: any, next: () => void) => {
    const perms: string[] = req.user?.permissions ?? [];
    if (perms.includes(perm)) return next();
    return res.status(403).json({ code: 'INSUFFICIENT_PERMISSIONS' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

jest.unstable_mockModule('../src/services/compliance-scan-service.js', () => ({
  complianceScanService: {
    create: (...args: unknown[]) => createMock(...args),
    cancel: (...args: unknown[]) => cancelMock(...args),
  },
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...args: unknown[]) => emitComplianceAuditMock(...args),
}));

const { createScanRoutes } = await import('../src/routes/scans.js');

/** Drive the full middleware+handler stack for a route, like express would. */
async function runRoute(method: 'post', path: string, req: any, res: any) {
  const router = createScanRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack as Array<{ handle: Function }>;
  let idx = 0;
  const next = async (): Promise<void> => {
    if (idx < stack.length) {
      const handle = stack[idx++].handle;
      await handle(req, res, next);
    }
  };
  await next();
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const SCAN_ID = '22222222-2222-4222-8222-222222222222';

describe('POST /compliance/scans — requires compliance:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('403s a member WITHOUT compliance:write (scan not launched)', async () => {
    const { res, status, json } = makeRes();
    await runRoute('post', '/', {
      __orgId: 'org-a',
      body: { target: 'all' },
      user: { permissions: [] },
    }, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(createMock).not.toHaveBeenCalled();
  });

  it('lets a caller WITH compliance:write launch a scan (201)', async () => {
    const { res, status } = makeRes();
    await runRoute('post', '/', {
      __orgId: 'org-a',
      body: { target: 'all' },
      user: { permissions: ['compliance:write'] },
    }, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(createMock).toHaveBeenCalled();
  });
});

describe('POST /compliance/scans/:id/cancel — requires compliance:write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('403s a member WITHOUT compliance:write (cancel not run, no audit)', async () => {
    const { res, status, json } = makeRes();
    await runRoute('post', '/:id/cancel', {
      __orgId: 'org-a',
      params: { id: SCAN_ID },
      user: { permissions: [] },
    }, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }));
    expect(cancelMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });

  it('lets a caller WITH compliance:write cancel (200) and still emits the audit', async () => {
    const { res, status } = makeRes();
    await runRoute('post', '/:id/cancel', {
      __orgId: 'org-a',
      params: { id: SCAN_ID },
      user: { permissions: ['compliance:write'] },
    }, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(cancelMock).toHaveBeenCalled();
    // Tier-2 audit emission on the cancel route is preserved.
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.scan.cancel',
      targetId: SCAN_ID,
    }));
  });
});
