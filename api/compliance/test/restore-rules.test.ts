// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/restore-rules (POST /:id/restore).
 *
 * Mirrors the sibling rule-audit.test.ts mocking approach. The restore route
 * loads the own-org tombstone, restores it (the service's onAfterRestore hook
 * re-enters the rule into evaluation — out of scope for these route tests),
 * 404s on either miss, 400s on a missing id, and emits an attributed
 * `compliance.rule.restore` event with `affectedOrgId: existing.orgId` only
 * after the restore succeeds.
 *
 * `requireStepUp` sits on the route as a separate middleware layer; `lastHandler`
 * grabs the final withRoute business handler, so the step-up guard (a mocked
 * pass-through) is skipped here.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findDeletedByIdMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const restoreMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
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

class InvalidRuleRegexError extends Error {}
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: {
    findDeletedById: (...a: unknown[]) => findDeletedByIdMock(...a),
    restore: (...a: unknown[]) => restoreMock(...a),
  },
  InvalidRuleRegexError,
}));

const { createRestoreRuleRoutes } = await import('../src/routes/restore-rules.js');

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

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const USER = { sub: 'u-1', email: 'u1@example.com', organizationId: 'org-a' };

beforeEach(() => jest.clearAllMocks());

describe('POST /:id/restore — restore emits compliance.rule.restore', () => {
  it('restores the tombstone and emits on success', async () => {
    findDeletedByIdMock.mockResolvedValueOnce({ id: RULE_ID, orgId: 'org-a', name: 'No latest tag' });
    restoreMock.mockResolvedValueOnce({ id: RULE_ID, orgId: 'org-a', name: 'No latest tag' });
    const handler = lastHandler(createRestoreRuleRoutes(), '/:id/restore', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, user: USER } as any, res);

    expect(findDeletedByIdMock).toHaveBeenCalledWith(RULE_ID, 'org-a');
    expect(restoreMock).toHaveBeenCalledWith(RULE_ID, 'org-a', 'u-1');
    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledTimes(1);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.restore',
      actorId: 'u-1',
      orgId: 'org-a',
      affectedOrgId: 'org-a', // existing.orgId
      targetType: 'rule',
      targetId: RULE_ID,
      details: { name: 'No latest tag' },
    }));
  });

  it('returns 404 and does not emit when the tombstone does not exist', async () => {
    findDeletedByIdMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createRestoreRuleRoutes(), '/:id/restore', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(restoreMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });

  it('returns 404 and does not emit when restore returns null', async () => {
    findDeletedByIdMock.mockResolvedValueOnce({ id: RULE_ID, orgId: 'org-a', name: 'No latest tag' });
    restoreMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createRestoreRuleRoutes(), '/:id/restore', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, user: USER } as any, res);

    expect(restoreMock).toHaveBeenCalledWith(RULE_ID, 'org-a', 'u-1');
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });

  it('returns 400 and does not touch the service when the id is missing', async () => {
    const handler = lastHandler(createRestoreRuleRoutes(), '/:id/restore', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: {}, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(findDeletedByIdMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
