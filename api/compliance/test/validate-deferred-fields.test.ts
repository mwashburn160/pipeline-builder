// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `deferredFields` on POST /validate/{target} is a SERVICE-only input.
 *
 * It names attributes the caller "cannot know yet", and every rule reading one
 * is SKIPPED rather than evaluated. Its only legitimate senders are internal
 * services (api/plugin's pre-build and post-build checks, which re-validate the
 * deferred image facts later). A USER token able to send it could skip any rule
 * it liked — `deferredFields: ['signed', 'scanned']` and the image-signing
 * policy passes — so a user token that sends it is refused 400.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const evaluateEntityMock = jest.fn(async (..._a: unknown[]) => ({
  result: { passed: true, violations: [], warnings: [], blocked: false, rulesEvaluated: 0, rulesSkipped: 0, exemptionsApplied: [] },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: () => false,
  validateBody: (req: any, _schema: any) => ({ ok: true, value: req.body }),
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) => res.status(400).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ data })),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  observe: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => h({ req, res, ctx: { log: jest.fn() }, orgId: 'org-a', userId: req.user?.sub ?? 'u' }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {}));
jest.unstable_mockModule('../src/helpers/evaluate-entity.js', () => ({ evaluateEntity: (...a: unknown[]) => evaluateEntityMock(...a) }));
jest.unstable_mockModule('../src/helpers/compliance-check-log.js', () => ({ logComplianceCheck: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/compliance-notifier.js', () => ({
  notifyComplianceBlock: jest.fn(async () => undefined),
  notifyComplianceWarnings: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy-client.js', () => ({ resolveParentOrgId: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/services/compliance-exemption-service.js', () => ({
  complianceExemptionService: { getActiveExemptionsForEntity: jest.fn(async () => []) },
}));
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { findActiveByOrgAndTarget: jest.fn(async () => []) },
}));

const { createValidateRoutes } = await import('../src/routes/validate.js');

function handlerFor(target: 'plugin' | 'pipeline') {
  const router = createValidateRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === `/${target}` && l.route?.methods?.post);
  if (!layer) throw new Error(`no POST /${target}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function validate(target: 'plugin' | 'pipeline', user: any, body: any) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  await handlerFor(target)({ body, user } as any, { status, json } as any);
  return { status, json };
}

const USER = { sub: 'u-1', organizationId: 'org-a', permissions: ['compliance:read'] };
const SERVICE = { sub: 'service:plugin', principalType: 'service', organizationId: 'org-a' };

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /validate/{target} — deferredFields is service-only', () => {
  it.each(['plugin', 'pipeline'] as const)('400s a USER token that sends deferredFields (%s), without evaluating', async (target) => {
    const { status, json } = await validate(target, USER, { attributes: {}, deferredFields: ['signed', 'scanned'] });
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(evaluateEntityMock).not.toHaveBeenCalled();
  });

  it('still lets a USER token validate without deferredFields', async () => {
    const { status } = await validate('plugin', USER, { attributes: {} });
    expect(status).toHaveBeenCalledWith(200);
    expect(evaluateEntityMock).toHaveBeenCalledWith(expect.objectContaining({ deferredFields: [] }));
  });

  it('a SERVICE principal still sends deferredFields and they reach evaluation', async () => {
    const { status } = await validate('plugin', SERVICE, { attributes: {}, deferredFields: ['signed', 'scanned'] });
    expect(status).toHaveBeenCalledWith(200);
    expect(evaluateEntityMock).toHaveBeenCalledWith(expect.objectContaining({ deferredFields: ['signed', 'scanned'] }));
  });
});
