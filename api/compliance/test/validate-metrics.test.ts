// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The validate path is metered: `compliance_validate_total{target,result}` for
 * enforcement checks (never dry-runs) plus a duration histogram, and a lost
 * check-log row is COUNTED as `compliance_audit_write_failures_total{kind}` —
 * it stays async (the caller waits on the verdict, not the log), but a hole in
 * the compliance audit trail must be alertable rather than a warn line.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncCounter = jest.fn();
const mockObserve = jest.fn();
const mockLogCheck = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
let verdict: { blocked: boolean; warnings: unknown[]; violations: unknown[] } = { blocked: false, warnings: [], violations: [] };
let isAdmin = false;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isSystemAdmin: () => isAdmin,
  validateBody: (req: any) => ({ ok: true, value: req.body }),
  sendBadRequest: jest.fn(),
  sendSuccess: jest.fn(),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  observe: (...a: unknown[]) => mockObserve(...a),
  withRoute: (h: Function) => async (req: any, res: any) => h({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u-1' }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {}));
jest.unstable_mockModule('../src/helpers/evaluate-entity.js', () => ({
  evaluateEntity: jest.fn(async () => {
    if (verdict === null) throw new Error('rules unavailable');
    return { result: { passed: !verdict.blocked, rulesEvaluated: 1, rulesSkipped: 0, exemptionsApplied: [], ...verdict } };
  }),
}));
jest.unstable_mockModule('../src/helpers/compliance-check-log.js', () => ({ logComplianceCheck: (...a: unknown[]) => mockLogCheck(...a) }));
jest.unstable_mockModule('../src/helpers/compliance-notifier.js', () => ({
  notifyComplianceBlock: jest.fn(async () => undefined),
  notifyComplianceWarnings: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy-client.js', () => ({ resolveParentOrgId: async () => undefined }));
jest.unstable_mockModule('../src/services/compliance-exemption-service.js', () => ({
  complianceExemptionService: { getActiveExemptionsForEntity: jest.fn(async () => []) },
}));
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { findActiveByOrgAndTarget: async () => [] },
}));

const { createValidateRoutes } = await import('../src/routes/validate.js');

function handler(path: string) {
  const router = createValidateRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const run = (path: string) => handler(path)({ body: { attributes: {} }, user: { sub: 'u-1', parentOrganizationId: 'root' } } as any, {} as any);
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  isAdmin = false;
  verdict = { blocked: false, warnings: [], violations: [] };
  mockLogCheck.mockResolvedValue(undefined);
});

describe('compliance_validate_total', () => {
  it.each([
    [{ blocked: false, warnings: [], violations: [] }, 'passed'],
    [{ blocked: false, warnings: [{}], violations: [] }, 'warned'],
    [{ blocked: true, warnings: [], violations: [{}] }, 'blocked'],
  ])('counts a live check by target and result (%#)', async (v, result) => {
    verdict = v;
    await run('/plugin');
    expect(mockIncCounter).toHaveBeenCalledWith('compliance_validate_total', { target: 'plugin', result });
    expect(mockObserve).toHaveBeenCalledWith('compliance_validate_duration_seconds', { target: 'plugin' }, expect.any(Number));
  });

  it('counts a sysadmin check as skipped', async () => {
    isAdmin = true;
    await run('/pipeline');
    expect(mockIncCounter).toHaveBeenCalledWith('compliance_validate_total', { target: 'pipeline', result: 'skipped' });
  });

  it('counts a failed evaluation as error and still rethrows', async () => {
    verdict = null as never;
    await expect(run('/plugin')).rejects.toThrow('rules unavailable');
    expect(mockIncCounter).toHaveBeenCalledWith('compliance_validate_total', { target: 'plugin', result: 'error' });
  });

  it('does NOT count a dry-run (a preview, not enforcement) but times it', async () => {
    await run('/plugin/dry-run');
    expect(mockIncCounter).not.toHaveBeenCalledWith('compliance_validate_total', expect.anything());
    expect(mockObserve).toHaveBeenCalledWith('compliance_validate_duration_seconds', { target: 'plugin' }, expect.any(Number));
    expect(mockLogCheck).not.toHaveBeenCalled();
  });
});

describe('check-log write failures', () => {
  it('a lost check-log row is counted, and the verdict is still returned', async () => {
    mockLogCheck.mockRejectedValue(new Error('pg down'));
    await expect(run('/plugin')).resolves.toBeUndefined();
    await flush();
    expect(mockIncCounter).toHaveBeenCalledWith('compliance_audit_write_failures_total', { kind: 'check_log' });
  });

  it('a successful write counts nothing', async () => {
    await run('/plugin');
    await flush();
    expect(mockIncCounter).not.toHaveBeenCalledWith('compliance_audit_write_failures_total', expect.anything());
  });
});
