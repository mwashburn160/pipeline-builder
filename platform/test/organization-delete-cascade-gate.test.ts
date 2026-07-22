// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the SOFT-DELETE / restore controller flow.
 *
 * `DELETE /organization/:id` no longer runs the destructive cascade inline — it
 * soft-deletes (snapshot + tombstone + session cut via `softDeleteOrg`) and
 * returns 202 with the purge deadline. The fail-closed cascade now lives in the
 * purge sweep (see org-purge.test.ts). `POST /organization/:id/restore` reverses
 * a soft-delete within the window.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSoftDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRestore = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockExpandOrgScope = jest.fn<(...a: unknown[]) => Promise<string[]>>();
const mockCanAdminister = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockAudit = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  isServicePrincipal: () => false,
  sendError: (res: any, status: number, message: string, code?: string, details?: unknown) =>
    res.status(status).json({ success: false, message, code, details }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) =>
    res.status(status).json({ success: true, statusCode: status, data, message }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireSystemAdmin: (_req: any, _res: any) => true,
  requireAuth: (_req: any, _res: any) => true,
  canAccessOrg: jest.fn(),
  canAdministerOrg: (...a: unknown[]) => mockCanAdminister(...a),
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try {
        await fn(req, res);
      } catch (err: any) {
        // Mirror withController's errorMap behaviour so throw-based typed errors
        // (ORG_SNAPSHOT_FAILED, ...) map to the right status in these tests.
        const mapped = errorMap?.[err?.message];
        if (mapped) return res.status(mapped.status).json({ success: false, message: mapped.message });
        return res.status(500).json({ success: false, message: 'error' });
      }
    },
}));

jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  expandOrgScope: (...a: unknown[]) => mockExpandOrgScope(...a),
}));

jest.unstable_mockModule('../src/helpers/seats.js', () => ({ pooledSeatUsage: jest.fn(), pooledFeatureEntitlements: jest.fn() }));

jest.unstable_mockModule('../src/services/index.js', () => ({
  organizationService: { delete: (...a: unknown[]) => mockDelete(...a), restore: (...a: unknown[]) => mockRestore(...a) },
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  SYSTEM_ORG_DELETE_FORBIDDEN: 'SYSTEM_ORG_DELETE_FORBIDDEN',
  ORG_SLUG_TAKEN: 'ORG_SLUG_TAKEN',
  ORG_AI_KEY_TOO_LONG: 'ORG_AI_KEY_TOO_LONG',
  changedAiProviderFields: () => [],
}));

jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  softDeleteOrg: (...a: unknown[]) => mockSoftDelete(...a),
  exportOrg: jest.fn(),
  ORG_ALREADY_DELETED: 'ORG_ALREADY_DELETED',
  ORG_SNAPSHOT_FAILED: 'ORG_SNAPSHOT_FAILED',
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: jest.fn(),
  createOrganizationSchema: {},
  updateOrganizationSchema: {},
  updateOrgIdentitySchema: {},
  updateQuotasSchema: {},
}));

const { deleteOrganization, restoreOrganization } = await import('../src/controllers/organization.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const req = () => ({ user: { sub: 'admin-1', organizationId: 'sysorg' }, params: { id: 'org-acme' }, body: {} });

beforeEach(() => {
  jest.clearAllMocks();
  mockExpandOrgScope.mockResolvedValue(['org-acme']); // flat org, no teams
  mockCanAdminister.mockResolvedValue(true);
});

describe('deleteOrganization — soft-delete', () => {
  it('soft-deletes (202 + org.soft_delete audit) and does NOT run the destructive cascade', async () => {
    const purgeAfter = new Date(Date.now() + 7 * 86400_000);
    mockSoftDelete.mockResolvedValue({ orgId: 'org-acme', deletedAt: new Date(), purgeAfter, snapshotId: 'snap-1', membersInvalidated: 3 });
    const res = mockRes();

    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    // Soft-delete was invoked with (orgId, actorOrgId, deletedBy).
    expect(mockSoftDelete).toHaveBeenCalledWith('org-acme', 'sysorg', 'admin-1');
    // No inline hard delete.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.soft_delete', expect.objectContaining({ affectedOrgId: 'org-acme' }));
  });

  it('blocks a root org that still has live teams (400, no soft-delete)', async () => {
    mockExpandOrgScope.mockResolvedValue(['org-acme', 'team-1']);
    const res = mockRes();

    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(mockSoftDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('maps a snapshot failure to 502 and does NOT audit a delete that did not happen', async () => {
    mockSoftDelete.mockRejectedValue(new Error('ORG_SNAPSHOT_FAILED'));
    const res = mockRes();

    await (deleteOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('restoreOrganization', () => {
  it('restores within the window (200 + org.restore audit)', async () => {
    mockRestore.mockResolvedValue({ id: 'org-acme', name: 'Acme', membersInvalidated: 3 });
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(mockRestore).toHaveBeenCalledWith('org-acme');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.restore', expect.objectContaining({ affectedOrgId: 'org-acme' }));
  });

  it('404s when the org was already purged (nothing to restore)', async () => {
    mockRestore.mockResolvedValue(null);
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('403s a caller who does not administer the org', async () => {
    mockCanAdminister.mockResolvedValue(false);
    const res = mockRes();

    await (restoreOrganization as unknown as (req: any, res: any) => Promise<void>)(req(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockRestore).not.toHaveBeenCalled();
  });
});
