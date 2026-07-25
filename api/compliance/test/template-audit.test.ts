// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-emission test for POST /apply (rule templates). Applying a template
 * mints an enforceable org rule, so each rule ACTUALLY created emits an
 * attributed `compliance.template.apply` (targetId = the new rule, details name
 * the source template). Nothing is emitted for templates that failed to apply
 * or on the validation-failure path.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const emitComplianceAuditMock = jest.fn();

let validatePasses = true;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  validateBody: (req: any) =>
    validatePasses ? { ok: true, value: req.body } : { ok: false, error: 'invalid' },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));

jest.unstable_mockModule('../src/data/rule-templates.js', () => ({
  RULE_TEMPLATES: [
    { id: 'tmpl-a', name: 'Template A', description: '', target: 'plugin', severity: 'error', field: 'f', operator: 'eq', value: 1, priority: 0, tags: [] },
    { id: 'tmpl-b', name: 'Template B', description: '', target: 'pipeline', severity: 'error', field: 'g', operator: 'eq', value: 2, priority: 0, tags: [] },
  ],
}));

jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({
  emitComplianceAudit: (...a: unknown[]) => emitComplianceAuditMock(...a),
  getAuditClient: () => ({ record: jest.fn() }),
}));

jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: {
    create: (...a: unknown[]) => createMock(...a),
  },
}));

const { createTemplateRoutes } = await import('../src/routes/templates.js');

function lastHandler(path: string, method: string) {
  const router = createTemplateRoutes();
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

const RULE_A = '77777777-7777-4777-8777-777777777777';
const USER = { sub: 'u-1', email: 'u1@example.com', organizationId: 'org-a' };

beforeEach(() => {
  jest.clearAllMocks();
  validatePasses = true;
});

describe('POST /apply — emits compliance.template.apply per applied template', () => {
  it('emits one event per rule ACTUALLY minted, with the source template in details', async () => {
    // Two templates requested; only the first successfully mints a rule.
    createMock
      .mockResolvedValueOnce({ id: RULE_A })
      .mockRejectedValueOnce(new Error('duplicate'));
    const handler = lastHandler('/apply', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', body: { templateIds: ['tmpl-a', 'tmpl-b'] }, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(201);
    // Only the applied template produced an audit event.
    expect(emitComplianceAuditMock).toHaveBeenCalledTimes(1);
    expect(emitComplianceAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.template.apply',
      actorId: 'u-1',
      orgId: 'org-a',
      targetType: 'rule',
      targetId: RULE_A,
      details: { templateId: 'tmpl-a', name: 'Template A' },
    }));
  });

  it('does not emit when validation fails', async () => {
    validatePasses = false;
    const handler = lastHandler('/apply', 'post');
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-a', body: {}, user: USER } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(emitComplianceAuditMock).not.toHaveBeenCalled();
  });
});
