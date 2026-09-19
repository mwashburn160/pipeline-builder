// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `listAlertRules` pages server-side: it parses `?offset&limit`, hands them to
 * the service, and returns the shared `{ total, offset, limit, hasMore }`
 * envelope — the alert-rules page used to fetch every rule in one unbounded read.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockListForOrg = jest.fn<(...a: unknown[]) => Promise<{ rules: unknown[]; total: number }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  sendQuotaReserveDenied: jest.fn(),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
  requireOrgMembership: (req: any) => req.user?.organizationId ?? null,
  requireAuthContext: jest.fn(),
}));
jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  reserveFeatureQuota: jest.fn(),
  releaseFeatureQuota: jest.fn(),
}));
jest.unstable_mockModule('../src/services/promql-rewriter.js', () => ({ PromQLRewriteError: class extends Error {} }));
jest.unstable_mockModule('../src/services/alert-rule-service.js', () => ({
  alertRuleService: { listForOrg: (...a: unknown[]) => mockListForOrg(...a) },
  prepareRuleExpr: jest.fn(),
  renderRulesYaml: jest.fn(),
  validateRule: jest.fn(),
}));

const { listAlertRules } = await import('../src/controllers/alert-rules.js');
const call = listAlertRules as unknown as (req: any, res: any) => Promise<void>;

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => { mockListForOrg.mockReset(); });

describe('listAlertRules pagination', () => {
  it('forwards offset/limit to the org-scoped service call', async () => {
    mockListForOrg.mockResolvedValue({ rules: [], total: 0 });
    await call({ user: { organizationId: 'org-a' }, query: { offset: '25', limit: '25' } }, mockRes());
    expect(mockListForOrg).toHaveBeenCalledWith('org-a', { offset: 25, limit: 25 });
  });

  it('returns the page plus a hasMore envelope derived from total', async () => {
    mockListForOrg.mockResolvedValue({ rules: [{ id: 'r1' }], total: 30 });
    const res = mockRes();
    await call({ user: { organizationId: 'org-a' }, query: { offset: '0', limit: '25' } }, res);
    const payload = (res.json as jest.Mock).mock.calls[0][0] as any;
    expect(payload.data.rules).toEqual([{ id: 'r1' }]);
    expect(payload.data.pagination).toEqual({ total: 30, offset: 0, limit: 25, hasMore: true });
  });

  it('reports hasMore=false on the last page', async () => {
    mockListForOrg.mockResolvedValue({ rules: [{ id: 'r26' }], total: 26 });
    const res = mockRes();
    await call({ user: { organizationId: 'org-a' }, query: { offset: '25', limit: '25' } }, res);
    expect(((res.json as jest.Mock).mock.calls[0][0] as any).data.pagination.hasMore).toBe(false);
  });
});
