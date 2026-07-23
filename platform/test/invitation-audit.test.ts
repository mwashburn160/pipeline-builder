// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-emission tests for the invitation controller. The whole invitation
 * lifecycle is a membership / privilege surface, so send / accept / revoke /
 * resend each emit an audit event. Two hard invariants are asserted here:
 *   - the event carries the invited email + role and the invitation's org as
 *     `affectedOrgId` (accept joins a DIFFERENT org than the actor's current);
 *   - the invitation TOKEN/secret NEVER leaks into `details`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockSend = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAccept = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRevoke = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockResend = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRequireOrgMembership = jest.fn();
const mockValidateBody = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) => res.status(status).json({ success: true, statusCode: status, data, message }),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: { email: { enabled: false } } }));

jest.unstable_mockModule('../src/controllers/oauth.js', () => ({
  verifyOAuthCode: jest.fn(), OAUTH_ERROR_MAP: {},
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireOrgMembership: (...a: unknown[]) => mockRequireOrgMembership(...a),
  withController: (_label: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (...a: unknown[]) => mockValidateBody(...a),
  sendInvitationSchema: {},
}));

const INV = [
  'INV_ORG_NOT_FOUND', 'INV_UNAUTHORIZED', 'INV_ALREADY_MEMBER', 'INV_ALREADY_SENT', 'INV_MAX_REACHED',
  'INV_SEAT_LIMIT', 'INV_INVITER_NOT_FOUND', 'INV_NOT_FOUND', 'INV_ACCEPTED', 'INV_EXPIRED', 'INV_REVOKED',
  'INV_USER_NOT_FOUND', 'INV_EMAIL_MISMATCH', 'INV_OAUTH_NOT_ALLOWED', 'INV_EMAIL_NOT_ALLOWED', 'INV_NOT_PENDING',
];
jest.unstable_mockModule('../src/services/index.js', () => ({
  invitationService: {
    send: (...a: unknown[]) => mockSend(...a),
    accept: (...a: unknown[]) => mockAccept(...a),
    revoke: (...a: unknown[]) => mockRevoke(...a),
    resend: (...a: unknown[]) => mockResend(...a),
  },
  auditService: { createEvent: jest.fn() },
  ...Object.fromEntries(INV.map((k) => [k, k])),
}));

const { sendInvitation, acceptInvitation, revokeInvitation, resendInvitation } =
  await import('../src/controllers/invitation.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const SECRET_TOKEN = 'super-secret-invite-token-abc123';

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgMembership.mockReturnValue('org-actor');
});

describe('invitation controller — audit emissions', () => {
  it('send → invitation.send with email + role, org as affectedOrgId, no token', async () => {
    mockValidateBody.mockReturnValue({ email: 'new@x.io', role: 'member' });
    mockSend.mockResolvedValue({
      invitation: { _id: 'inv-1', email: 'new@x.io', role: 'member', status: 'pending', token: SECRET_TOKEN },
      emailSent: true,
    });

    const res = makeRes();
    await (sendInvitation as any)({ user: { sub: 'u1', role: 'owner' }, body: {} }, res);

    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'invitation.send', expect.objectContaining({
      targetType: 'invitation',
      targetId: 'inv-1',
      affectedOrgId: 'org-actor',
      details: { email: 'new@x.io', role: 'member' },
    }));
    // The audit EVENT is the options arg (index 2) — `audit()` persists that
    // plus req.user, never req.body — so scope the leak check to what's emitted.
    expect(JSON.stringify(mockAudit.mock.calls.map((c: any) => c[2]))).not.toContain(SECRET_TOKEN);
  });

  it('accept → invitation.accept files under the JOINED org (not the actor org), actor is req.user', async () => {
    mockAccept.mockResolvedValue({ invitationId: 'inv-9', organizationId: 'org-joined', email: 'joiner@x.io', role: 'admin', userId: 'u1' });

    const req: any = { user: { sub: 'u1', organizationId: 'org-actor' }, headers: {}, body: { token: SECRET_TOKEN } };
    const res = makeRes();
    await (acceptInvitation as any)(req, res);

    // Actor is the accepting user (req passed through); affectedOrgId is the
    // invitation's org — the org being JOINED, which differs from org-actor.
    expect(mockAudit).toHaveBeenCalledWith(req, 'invitation.accept', expect.objectContaining({
      targetType: 'invitation',
      targetId: 'inv-9',
      affectedOrgId: 'org-joined',
      details: { email: 'joiner@x.io', role: 'admin' },
    }));
    // The audit EVENT is the options arg (index 2) — `audit()` persists that
    // plus req.user, never req.body — so scope the leak check to what's emitted.
    expect(JSON.stringify(mockAudit.mock.calls.map((c: any) => c[2]))).not.toContain(SECRET_TOKEN);
  });

  it('revoke → invitation.revoke with the invitation facts', async () => {
    mockRevoke.mockResolvedValue({ invitationId: 'inv-2', organizationId: 'org-actor', email: 'gone@x.io', role: 'member' });

    const res = makeRes();
    await (revokeInvitation as any)({ user: { sub: 'u1', role: 'admin' }, params: { invitationId: 'inv-2' } }, res);

    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'invitation.revoke', expect.objectContaining({
      targetType: 'invitation',
      targetId: 'inv-2',
      affectedOrgId: 'org-actor',
      details: { email: 'gone@x.io', role: 'member' },
    }));
  });

  it('resend → invitation.resend with email + role', async () => {
    mockResend.mockResolvedValue({ expiresAt: new Date(), emailSent: true, email: 're@x.io', role: 'member' });

    const res = makeRes();
    await (resendInvitation as any)({ user: { sub: 'u1', role: 'owner' }, params: { invitationId: 'inv-3' } }, res);

    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'invitation.resend', expect.objectContaining({
      targetType: 'invitation',
      targetId: 'inv-3',
      affectedOrgId: 'org-actor',
      details: { email: 're@x.io', role: 'member' },
    }));
  });
});
