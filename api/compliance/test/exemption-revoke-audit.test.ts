// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-emission test for DELETE /:id (exemption revoke). Revoking re-imposes a
 * rule and can block a previously-compliant entity, so it emits an attributed
 * `compliance.exemption.revoke` after a successful delete — with safe scalar
 * details only (the re-imposed rule + entity type, never the reason text) — and
 * nothing when the exemption is not found.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const deleteMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const emitComplianceAuditMock = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  validateBody: (req: any) => ({ ok: true, value: req.body }),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendEntityNotFound: jest.fn((res: any, what: string) => res.status(404).json({ message: what })),
  sendSuccess: jest.fn((res: any, status: number, data: any, message?: string) =>
    res.status(status).json({ success: true, statusCode: status, data, message })),
  sendPaginatedNested: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/compliance-exemption-service.js', () => ({
  complianceExemptionService: {
    delete: (...a: unknown[]) => deleteMock(...a),
  },
  CE_NOT_FOUND: 'CE_NOT_FOUND',
  CE_SELF_APPROVE: 'CE_SELF_APPROVE',
  CE_ALREADY_EXISTS: 'CE_ALREADY_EXISTS',
}));

const { createExemptionRoutes } = await import('../src/routes/exemptions.js');

function lastHandler(path: string, method: string) {
  const router = createExemptionRoutes();
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

const EXEMPTION_ID = '55555555-5555-4555-8555-555555555555';
const RULE_ID = '66666666-6666-4666-8666-666666666666';
const USER = { sub: 'u-1', email: 'u1@example.com', organizationId: 'org-a' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DELETE /:id — revoke emits compliance.exemption.revoke', () => {
  it('emits on success with actorId + targetId + safe details', async () => {
    deleteMock.mockResolvedValueOnce({ id: EXEMPTION_ID, ruleId: RULE_ID, entityType: 'plugin', reason: 'secret reason' });
    const handler = lastHandler('/:id', 'delete');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: EXEMPTION_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledTimes(1);
    const event = emitComplianceAuditMock.mock.calls[0][0] as any;
    expect(event).toEqual(expect.objectContaining({
      action: 'compliance.exemption.revoke',
      actorId: 'u-1',
      orgId: 'org-a',
      targetType: 'exemption',
      targetId: EXEMPTION_ID,
      details: { ruleId: RULE_ID, entityType: 'plugin' },
    }));
    // The exemption reason text must never leak into the audit details.
    expect(JSON.stringify(event.details)).not.toContain('secret reason');
  });

  it('does not emit when the exemption is not found', async () => {
    deleteMock.mockResolvedValueOnce(null);
    const handler = lastHandler('/:id', 'delete');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: EXEMPTION_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
