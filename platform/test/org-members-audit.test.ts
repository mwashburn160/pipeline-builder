// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests that the organization-member mutation handlers emit the
 * right audit events. Each privilege change MUST land in the audit log
 * with `affectedOrgId` set, so reviewers can answer "what was done
 * inside org X, by whom".
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockAudit = jest.fn();
const mockAddMember = jest.fn();
const mockRemoveMember = jest.fn();
const mockTransferOwnership = jest.fn();
const mockDeactivateMember = jest.fn();
const mockActivateMember = jest.fn();
const mockIsOrgOwner = jest.fn();
const mockValidateBody = jest.fn((_schema: unknown, body: unknown) => body);
const mockGetAdminContext: jest.Mock = jest.fn(() => ({ isSuperAdmin: true, isOrgAdmin: false, adminType: 'sysadmin' }));
const mockIsSystemAdmin: jest.Mock = jest.fn(() => true);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) => res.status(status).json({ success: true, statusCode: status, data, message }),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuth: () => true,
  isSystemAdmin: (req: unknown) => mockIsSystemAdmin(req),
  getAdminContext: (req: unknown) => mockGetAdminContext(req),
  // These tests stub the auth layer and assert audit emission; grant access so
  // the handlers proceed to the audit call.
  canAdministerOrg: async () => true,
  requireOrgAdmin: async () => true,
  canAccessOrg: async () => true,
  withController: (_label: string, fn: Function, _errMap?: unknown) =>
    async (req: any, res: any) => {
      try { await fn(req, res); } catch { /* swallowed for test - real withController maps to status */ }
    },
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  orgMembersService: {
    addMember: (...a: unknown[]) => mockAddMember(...a),
    removeMember: (...a: unknown[]) => mockRemoveMember(...a),
    transferOwnership: (...a: unknown[]) => mockTransferOwnership(...a),
    deactivateMember: (...a: unknown[]) => mockDeactivateMember(...a),
    activateMember: (...a: unknown[]) => mockActivateMember(...a),
    isOrgOwner: (...a: unknown[]) => mockIsOrgOwner(...a),
  },
  OM_ORG_NOT_FOUND: 'OM_ORG_NOT_FOUND',
  OM_USER_NOT_FOUND: 'OM_USER_NOT_FOUND',
  OM_ALREADY_MEMBER: 'OM_ALREADY_MEMBER',
  OM_NOT_A_MEMBER: 'OM_NOT_A_MEMBER',
  OM_CANNOT_REMOVE_OWNER: 'OM_CANNOT_REMOVE_OWNER',
  OM_OWNER_MEMBERSHIP_NOT_FOUND: 'OM_OWNER_MEMBERSHIP_NOT_FOUND',
  OM_NEW_OWNER_MUST_BE_MEMBER: 'OM_NEW_OWNER_MUST_BE_MEMBER',
  OM_MEMBERSHIP_NOT_FOUND: 'OM_MEMBERSHIP_NOT_FOUND',
  OM_ALREADY_INACTIVE: 'OM_ALREADY_INACTIVE',
  OM_ALREADY_ACTIVE: 'OM_ALREADY_ACTIVE',
  OM_TARGETS_OUT_OF_SCOPE: 'OM_TARGETS_OUT_OF_SCOPE',
  OM_SEAT_LIMIT: 'OM_SEAT_LIMIT',
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (schema: unknown, body: unknown, _res: unknown) => mockValidateBody(schema, body),
  addMemberSchema: {},
  bulkAddMemberSchema: {},
  transferOwnershipSchema: {},
}));

const {
  addMemberToOrganization,
  removeMemberFromOrganization,
  transferOrganizationOwnership,
  deactivateMember,
  activateMember,
} = await import('../src/controllers/organization-members.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockAudit.mockReset();
  mockAddMember.mockReset();
  mockRemoveMember.mockReset();
  mockTransferOwnership.mockReset();
  mockDeactivateMember.mockReset();
  mockActivateMember.mockReset();
  mockIsOrgOwner.mockReset();
  mockValidateBody.mockReset().mockImplementation((_s, body) => body);
  mockGetAdminContext.mockReset().mockReturnValue({ isSuperAdmin: true, isOrgAdmin: false, adminType: 'sysadmin' });
  mockIsSystemAdmin.mockReset().mockReturnValue(true);
});

describe('addMember audit', () => {
  it('records org.member.add with affectedOrgId + role detail', async () => {
    mockAddMember.mockResolvedValue(undefined);
    const req: any = {
      params: { id: 'org-acme' },
      body: { userId: 'u1', role: 'admin' },
      user: { sub: 'admin-1', organizationId: 'org-acme' },
    };
    await (addMemberToOrganization as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.member.add', expect.objectContaining({
      targetType: 'user',
      targetId: 'u1',
      affectedOrgId: 'org-acme',
      details: { role: 'admin' },
    }));
  });

  it('records targetId from email when userId omitted', async () => {
    mockAddMember.mockResolvedValue(undefined);
    const req: any = {
      params: { id: 'org-acme' },
      body: { email: 'new@example.com', role: 'member' },
      user: { sub: 'admin-1', organizationId: 'org-acme' },
    };
    await (addMemberToOrganization as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.member.add', expect.objectContaining({
      targetId: 'new@example.com',
    }));
  });
});

describe('removeMember audit', () => {
  it('records org.member.remove with affectedOrgId', async () => {
    mockRemoveMember.mockResolvedValue(undefined);
    const req: any = {
      params: { id: 'org-acme', userId: 'u1' },
      user: { sub: 'admin-1', organizationId: 'org-acme' },
    };
    await (removeMemberFromOrganization as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.member.remove', {
      targetType: 'user',
      targetId: 'u1',
      affectedOrgId: 'org-acme',
    });
  });
});

describe('transferOwnership audit', () => {
  it('records org.ownership.transfer with newOwnerId + actorType', async () => {
    mockIsOrgOwner.mockResolvedValue(true);
    mockTransferOwnership.mockResolvedValue(undefined);
    const req: any = {
      params: { id: 'org-acme' },
      body: { newOwnerId: 'u2' },
      user: { sub: 'u1', organizationId: 'org-acme' },
    };
    await (transferOrganizationOwnership as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.ownership.transfer', expect.objectContaining({
      targetType: 'organization',
      targetId: 'org-acme',
      affectedOrgId: 'org-acme',
      details: expect.objectContaining({ newOwnerId: 'u2' }),
    }));
  });
});

describe('deactivate / activate member audit', () => {
  it('records org.member.deactivate', async () => {
    mockDeactivateMember.mockResolvedValue(undefined);
    const req: any = {
      params: { id: 'org-acme', userId: 'u1' },
      user: { sub: 'admin-1', organizationId: 'org-acme' },
    };
    await (deactivateMember as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());
    expect(mockAudit).toHaveBeenCalledWith(req, 'org.member.deactivate', {
      targetType: 'user',
      targetId: 'u1',
      affectedOrgId: 'org-acme',
    });
  });

  it('records org.member.activate', async () => {
    mockActivateMember.mockResolvedValue(undefined);
    const req: any = {
      params: { id: 'org-acme', userId: 'u1' },
      user: { sub: 'admin-1', organizationId: 'org-acme' },
    };
    await (activateMember as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());
    expect(mockAudit).toHaveBeenCalledWith(req, 'org.member.activate', {
      targetType: 'user',
      targetId: 'u1',
      affectedOrgId: 'org-acme',
    });
  });
});

describe('failure path — no audit event on service error', () => {
  it('does not audit if removeMember throws', async () => {
    mockRemoveMember.mockRejectedValue(new Error('OM_NOT_A_MEMBER'));
    const req: any = {
      params: { id: 'org-acme', userId: 'u1' },
      user: { sub: 'admin-1', organizationId: 'org-acme' },
    };
    await (removeMemberFromOrganization as unknown as (req: any, res: any) => Promise<void>)(req, mockRes());
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
