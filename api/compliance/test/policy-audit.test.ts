// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-emission tests for the policy-authoring routes. Each mutating policy
 * route emits its attributed `compliance.policy.*` event with actorId = the
 * acting user and targetId = the policy, only AFTER the mutation succeeds, and
 * nothing on the validation-failure / not-found paths.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const updateMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const deleteMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const emitComplianceAuditMock = jest.fn();

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

// create-policies wraps its work in withTenantTx; run the callback with a
// chainable tx stub (the rule-linking branch is skipped when no rules given).
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { complianceRule: {} },
  withTenantTx: async (fn: any) => fn({
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  and: jest.fn(), eq: jest.fn(), inArray: jest.fn(),
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/policy-service.js', () => ({
  compliancePolicyService: {
    create: (...a: unknown[]) => createMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

const { createCreatePolicyRoutes } = await import('../src/routes/create-policies.js');
const { createUpdatePolicyRoutes } = await import('../src/routes/update-policies.js');
const { createDeletePolicyRoutes } = await import('../src/routes/delete-policies.js');

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

beforeEach(() => {
  jest.clearAllMocks();
  validatePasses = true;
});

describe('POST / — create emits compliance.policy.create', () => {
  it('emits on success', async () => {
    createMock.mockResolvedValueOnce({ id: POLICY_ID, name: 'Baseline', version: '1.0.0', isTemplate: false });
    const handler = lastHandler(createCreatePolicyRoutes(), '/', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', body: { name: 'Baseline', isTemplate: false }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(201);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.policy.create',
      actorId: 'u-1',
      targetType: 'policy',
      targetId: POLICY_ID,
      details: { name: 'Baseline', version: '1.0.0', isTemplate: false },
    }));
  });

  it('does not emit when validation fails', async () => {
    validatePasses = false;
    const handler = lastHandler(createCreatePolicyRoutes(), '/', 'post');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', body: {}, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('PUT /:id — update emits compliance.policy.update', () => {
  it('emits on success', async () => {
    updateMock.mockResolvedValueOnce({ id: POLICY_ID, name: 'Baseline v2', version: '2.0.0', isActive: true });
    const handler = lastHandler(createUpdatePolicyRoutes(), '/:id', 'put');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, body: { name: 'Baseline v2' }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.policy.update',
      targetId: POLICY_ID,
      details: { name: 'Baseline v2', version: '2.0.0', isActive: true },
    }));
  });

  it('does not emit when not found', async () => {
    updateMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createUpdatePolicyRoutes(), '/:id', 'put');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, body: { name: 'x' }, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /:id — delete emits compliance.policy.delete', () => {
  it('emits on success', async () => {
    deleteMock.mockResolvedValueOnce({ id: POLICY_ID, name: 'Gone' });
    const handler = lastHandler(createDeletePolicyRoutes(), '/:id', 'delete');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.policy.delete',
      targetId: POLICY_ID,
      details: { name: 'Gone' },
    }));
  });

  it('does not emit when not found', async () => {
    deleteMock.mockResolvedValueOnce(null);
    const handler = lastHandler(createDeletePolicyRoutes(), '/:id', 'delete');
    const { res, status } = makeRes();
    await handler({ __orgId: 'org-a', params: { id: POLICY_ID }, user: USER } as any, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
