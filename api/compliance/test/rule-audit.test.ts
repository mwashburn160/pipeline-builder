// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-emission tests for the rule-authoring routes.
 *
 * Each mutating rule route must emit its attributed `compliance.rule.*` event
 * with the acting user as actorId and the affected rule as targetId AFTER the
 * mutation succeeds, and must emit NOTHING on the validation-failure path.
 * Emission is fire-and-forget (mirrors the existing toggle audit); details
 * carry only safe scalar metadata, never the full rule body.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const updateMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const deleteMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const emitComplianceAuditMock = jest.fn();

// Toggle validateBody between the success and the validation-failure path.
let validatePasses = true;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  isSystemAdmin: () => true,
  validateBody: (req: any) =>
    validatePasses ? { ok: true, value: req.body } : { ok: false, error: 'invalid' },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) =>
    res.status(status).json({ message: msg, code })),
  sendEntityNotFound: jest.fn((res: any, what: string) => res.status(404).json({ message: what })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

class InvalidRuleRegexError extends Error {}
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: {
    create: (...a: unknown[]) => createMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
  InvalidRuleRegexError,
}));

const { createCreateRuleRoutes } = await import('../src/routes/create-rules.js');
const { createUpdateRuleRoutes } = await import('../src/routes/update-rules.js');
const { createDeleteRuleRoutes } = await import('../src/routes/delete-rules.js');

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

beforeEach(() => {
  jest.clearAllMocks();
  validatePasses = true;
});

describe('POST / — create emits compliance.rule.create', () => {
  it('emits on success with actorId + targetId + safe details', async () => {
    createMock.mockResolvedValueOnce({ id: RULE_ID, name: 'No latest tag', target: 'plugin', scope: 'org' });
    const handler = lastHandler(createCreateRuleRoutes(), '/', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', body: { name: 'No latest tag', scope: 'org' }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(emitComplianceAuditMock).toHaveBeenCalledTimes(1);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.create',
      actorId: 'u-1',
      orgId: 'org-a',
      targetType: 'rule',
      targetId: RULE_ID,
      details: { name: 'No latest tag', target: 'plugin', scope: 'org' },
    }));
  });

  it('does not emit when validation fails', async () => {
    validatePasses = false;
    const handler = lastHandler(createCreateRuleRoutes(), '/', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', body: {}, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('PUT /:id — update emits compliance.rule.update', () => {
  it('emits on success', async () => {
    updateMock.mockResolvedValueOnce({ id: RULE_ID, name: 'Updated', target: 'pipeline', scope: 'org' });
    const handler = lastHandler(createUpdateRuleRoutes(), '/:id', 'put');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, body: { name: 'Updated' }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.update',
      targetId: RULE_ID,
      details: { name: 'Updated', target: 'pipeline', scope: 'org' },
    }));
  });

  it('does not emit when the rule is not found', async () => {
    updateMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createUpdateRuleRoutes(), '/:id', 'put');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, body: { name: 'x' }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });

  it('does not emit when validation fails', async () => {
    validatePasses = false;
    const handler = lastHandler(createUpdateRuleRoutes(), '/:id', 'put');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, body: {}, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(updateMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /:id — delete emits compliance.rule.delete', () => {
  it('emits on success', async () => {
    deleteMock.mockResolvedValueOnce({ id: RULE_ID, name: 'Gone' });
    const handler = lastHandler(createDeleteRuleRoutes(), '/:id', 'delete');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.rule.delete',
      targetId: RULE_ID,
      details: { name: 'Gone' },
    }));
  });

  it('does not emit when the rule is not found', async () => {
    deleteMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createDeleteRuleRoutes(), '/:id', 'delete');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: RULE_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
