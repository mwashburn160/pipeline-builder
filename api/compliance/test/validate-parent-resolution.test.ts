// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * #8 — the live validate path resolves the caller org's parent for
 * parent-`propagateToChildren` enforcement. It PREFERS the JWT claim
 * (`parentOrganizationId`, the interactive-member fast path) but falls back to
 * the org-hierarchy client when the claim is absent — a SERVICE-token caller
 * (api/pipeline, api/plugin forwarding an upload check) carries no such claim yet
 * its team may still inherit a parent's blocking rules. A hierarchy lookup
 * failure is fail-closed (the throw propagates; no false-pass).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const findActiveMock = jest.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
const resolveParentMock = jest.fn<(orgId: string) => Promise<string | undefined>>(async () => undefined);
let isAdmin = false;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: () => isAdmin,
  validateBody: (req: any, schema: any) => ({ ok: true, value: req.body }),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ data })),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.user?.sub ?? 'u' }),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({}));

jest.unstable_mockModule('../src/engine/rule-engine.js', () => ({
  evaluateRules: jest.fn(() => ({ passed: true, violations: [], warnings: [], blocked: false, rulesEvaluated: 0, rulesSkipped: 0, exemptionsApplied: [] })),
}));
jest.unstable_mockModule('../src/helpers/compliance-check-log.js', () => ({ logComplianceCheck: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/compliance-notifier.js', () => ({
  notifyComplianceBlock: jest.fn(async () => undefined),
  notifyComplianceWarnings: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/helpers/env.js', () => ({ parseIntEnv: (_v: unknown, d: number) => d }));
jest.unstable_mockModule('../src/helpers/org-hierarchy-client.js', () => ({
  resolveParentOrgId: (...a: unknown[]) => resolveParentMock(...(a as [string])),
}));
jest.unstable_mockModule('../src/services/compliance-exemption-service.js', () => ({
  complianceExemptionService: { getActiveExemptionsForEntity: jest.fn(async () => []) },
}));
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { findActiveByOrgAndTarget: (...a: unknown[]) => findActiveMock(...a) },
}));

const { createValidateRoutes } = await import('../src/routes/validate.js');

function pluginHandler() {
  const router = createValidateRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/plugin' && l.route?.methods?.post);
  if (!layer) throw new Error('no POST /plugin');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

function validate(user: any) {
  const handler = pluginHandler();
  const { res } = makeRes();
  return handler({ __orgId: 'team-a', body: { attributes: {} }, user } as any, res);
}

beforeEach(() => {
  jest.clearAllMocks();
  isAdmin = false;
  resolveParentMock.mockResolvedValue(undefined);
});

describe('#8 parent-org resolution in validate', () => {
  it('uses the JWT parentOrganizationId when present (no hierarchy lookup)', async () => {
    await validate({ sub: 'u-1', parentOrganizationId: 'root-1' });
    expect(resolveParentMock).not.toHaveBeenCalled();
    expect(findActiveMock).toHaveBeenCalledWith('team-a', 'plugin', 'root-1');
  });

  it('falls back to the hierarchy client for a service token (no JWT parent)', async () => {
    resolveParentMock.mockResolvedValue('root-2');
    await validate({ sub: 'service:pipeline' });
    expect(resolveParentMock).toHaveBeenCalledWith('team-a');
    expect(findActiveMock).toHaveBeenCalledWith('team-a', 'plugin', 'root-2');
  });

  it('treats a genuine root org (hierarchy returns undefined) as parentless', async () => {
    resolveParentMock.mockResolvedValue(undefined);
    await validate({ sub: 'service:pipeline' });
    expect(findActiveMock).toHaveBeenCalledWith('team-a', 'plugin', undefined);
  });

  it('propagates a hierarchy lookup failure (fail-closed, no false-pass)', async () => {
    resolveParentMock.mockRejectedValue(new Error('platform unreachable'));
    await expect(validate({ sub: 'service:pipeline' })).rejects.toThrow('platform unreachable');
    expect(findActiveMock).not.toHaveBeenCalled();
  });

  it('skips the lookup for a sysadmin (exempt from enforcement)', async () => {
    isAdmin = true;
    await validate({ sub: 'admin-1' });
    expect(resolveParentMock).not.toHaveBeenCalled();
    // Sysadmin returns early before any rule fetch.
    expect(findActiveMock).not.toHaveBeenCalled();
  });
});
