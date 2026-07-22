// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC/audit Tier 2 — the sysadmin org-configuration mutations must leave a
 * trail:
 *  - `updateOrganizationQuotas` → `admin.org.quota.override` (records numeric
 *    old→new per quota type; numbers are not secrets).
 *  - `updateOrgAIConfig` → `admin.org.ai-config.update`, recording only WHICH
 *    provider slots changed (field names) and NEVER a provider API-key value.
 * A refactor that silently drops either audit call — or that leaks a key value
 * into `details` — should fail these tests loudly.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockGetRawQuotaLimits = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdateQuotas = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdateAIConfig = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  isServicePrincipal: () => false,
  sendError: (res: any, status: number, message: string, code?: string) =>
    res.status(status).json({ success: false, message, code }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) =>
    res.status(status).json({ success: true, statusCode: status, data, message }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireSystemAdmin: (_req: any, _res: any) => true,
  requireAuth: (_req: any, _res: any) => true,
  canAccessOrg: jest.fn(),
  canAdministerOrg: jest.fn(),
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: jest.fn() }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledSeatUsage: jest.fn(), pooledFeatureEntitlements: jest.fn() }));

// The AI-config audit records only the changed provider slot NAMES — mirror the
// real helper: return the body's keys (never their secret values).
jest.unstable_mockModule('../src/services/index.js', () => ({
  organizationService: {
    getRawQuotaLimits: (...a: unknown[]) => mockGetRawQuotaLimits(...a),
    updateQuotas: (...a: unknown[]) => mockUpdateQuotas(...a),
    updateAIConfig: (...a: unknown[]) => mockUpdateAIConfig(...a),
  },
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  SYSTEM_ORG_DELETE_FORBIDDEN: 'SYSTEM_ORG_DELETE_FORBIDDEN',
  ORG_SLUG_TAKEN: 'ORG_SLUG_TAKEN',
  ORG_AI_KEY_TOO_LONG: 'ORG_AI_KEY_TOO_LONG',
  changedAiProviderFields: (body: Record<string, unknown>) => Object.keys(body ?? {}),
}));

jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  softDeleteOrg: jest.fn(),
  exportOrg: jest.fn(),
  ORG_ALREADY_DELETED: 'ORG_ALREADY_DELETED',
  ORG_SNAPSHOT_FAILED: 'ORG_SNAPSHOT_FAILED',
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body,
  createOrganizationSchema: {},
  updateOrganizationSchema: {},
  updateOrgIdentitySchema: {},
  updateQuotasSchema: {},
}));

const { updateOrganizationQuotas, updateOrgAIConfig } = await import('../src/controllers/organization.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateOrganizationQuotas audit — admin.org.quota.override', () => {
  it('records the numeric old→new per quota type with affectedOrgId = the org', async () => {
    mockGetRawQuotaLimits.mockResolvedValue({ plugins: 10, pipelines: 5 });
    mockUpdateQuotas.mockResolvedValue({ plugins: 25, pipelines: 5 });

    const req: any = {
      user: { sub: 'admin-1', organizationId: 'sysorg' },
      params: { id: 'org-acme' },
      headers: { authorization: 'Bearer x' },
      body: { plugins: 25 },
    };
    await (updateOrganizationQuotas as any)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.org.quota.override', expect.objectContaining({
      targetType: 'organization',
      targetId: 'org-acme',
      affectedOrgId: 'org-acme',
      details: { changes: { plugins: { from: 10, to: 25 } } },
    }));
  });

  it('records from:null when the pre-override read is unavailable', async () => {
    mockGetRawQuotaLimits.mockRejectedValue(new Error('read failed'));
    mockUpdateQuotas.mockResolvedValue({ pipelines: 50 });

    const req: any = {
      user: { sub: 'admin-1', organizationId: 'sysorg' },
      params: { id: 'org-acme' },
      headers: {},
      body: { pipelines: 50 },
    };
    await (updateOrganizationQuotas as any)(req, mockRes());

    const details = (mockAudit.mock.calls[0] as any)[2].details;
    expect(details.changes.pipelines).toEqual({ from: null, to: 50 });
  });
});

describe('updateOrgAIConfig audit — admin.org.ai-config.update', () => {
  it('records only the changed provider slot NAMES, never a key value', async () => {
    mockUpdateAIConfig.mockResolvedValue({ openai: { configured: true } });

    const req: any = {
      user: { sub: 'admin-1', organizationId: 'org-acme' },
      body: { openai: 'sk-SUPER-SECRET-KEY-VALUE', anthropic: 'sk-ant-SECRET' },
    };
    await (updateOrgAIConfig as any)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const call = (mockAudit.mock.calls[0] as any);
    expect(call[1]).toBe('admin.org.ai-config.update');
    expect(call[2]).toMatchObject({
      targetType: 'organization',
      targetId: 'org-acme',
      affectedOrgId: 'org-acme',
      details: { providers: ['openai', 'anthropic'] },
    });
    // The secret key values must never reach the audit trail.
    expect(JSON.stringify(call[2].details)).not.toContain('SUPER-SECRET');
    expect(JSON.stringify(call[2].details)).not.toContain('sk-ant-SECRET');
  });
});
