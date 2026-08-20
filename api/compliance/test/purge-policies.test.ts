// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/purge-policies (POST /:id/purge).
 *
 * Mirrors the sibling restore-policies.test.ts. The purge route loads the own-org
 * tombstone, hard-deletes it via the service's `purgeById`, 404s on either miss,
 * 400s on a missing id, and emits an attributed `compliance.policy.purge` event
 * with `affectedOrgId: existing.orgId` only after the purge succeeds.
 *
 * Like restore, `requireStepUp` sits on the route as a separate middleware layer
 * (purge is an irreversible destructive action); `lastHandler` grabs the final
 * withRoute business handler, so the step-up guard (a mocked pass-through) is
 * skipped here.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findDeletedByIdMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const purgeByIdMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const emitComplianceAuditMock = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p?.[k],
  isSystemAdmin: () => true,
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) =>
    res.status(400).json({ message: msg, code })),
  sendEntityNotFound: jest.fn((res: any, what: string) => res.status(404).json({ message: what })),
  sendSuccess: jest.fn((res: any, status: number, data: any, message?: string) =>
    res.status(status).json({ success: true, statusCode: status, data, message })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    try {
      await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub });
    } catch (error: any) {
      res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
    }
  },
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/policy-service.js', () => ({
  compliancePolicyService: {
    findDeletedById: (...a: unknown[]) => findDeletedByIdMock(...a),
    purgeById: (...a: unknown[]) => purgeByIdMock(...a),
  },
}));

const { createPurgePolicyRoutes } = await import('../src/routes/purge-policies.js');

function lastHandler(router: any, path: string, method: string) {
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const POLICY_ID = '33333333-3333-4333-8333-333333333333';
const USER = { sub: 'u-1', email: 'u1@example.com', organizationId: 'org-a' };

beforeEach(() => jest.clearAllMocks());

describe('POST /:id/purge — purge emits compliance.policy.purge', () => {
  it('hard-deletes the tombstone and emits on success', async () => {
    findDeletedByIdMock.mockResolvedValueOnce({ id: POLICY_ID, orgId: 'org-a', name: 'Baseline' });
    purgeByIdMock.mockResolvedValueOnce(POLICY_ID);
    const handler = lastHandler(createPurgePolicyRoutes(), '/:id/purge', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, user: USER } as any, res);

    expect(findDeletedByIdMock).toHaveBeenCalledWith(POLICY_ID, 'org-a');
    expect(purgeByIdMock).toHaveBeenCalledWith(POLICY_ID, 'org-a');
    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledTimes(1);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.policy.purge',
      actorId: 'u-1',
      orgId: 'org-a',
      affectedOrgId: 'org-a', // existing.orgId
      targetType: 'policy',
      targetId: POLICY_ID,
      details: { name: 'Baseline' },
    }));
  });

  it('returns 404 and does not emit when the tombstone does not exist', async () => {
    findDeletedByIdMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createPurgePolicyRoutes(), '/:id/purge', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(purgeByIdMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });

  it('returns 404 and does not emit when purgeById returns null', async () => {
    findDeletedByIdMock.mockResolvedValueOnce({ id: POLICY_ID, orgId: 'org-a', name: 'Baseline' });
    purgeByIdMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createPurgePolicyRoutes(), '/:id/purge', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, user: USER } as any, res);

    expect(purgeByIdMock).toHaveBeenCalledWith(POLICY_ID, 'org-a');
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });

  it('returns 400 and does not touch the service when the id is missing', async () => {
    const handler = lastHandler(createPurgePolicyRoutes(), '/:id/purge', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: {}, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(findDeletedByIdMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
