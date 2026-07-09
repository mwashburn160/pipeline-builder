// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Security test for `acceptInvitationViaOAuth`.
 *
 * The endpoint is public. Its contract MUST be: verify the OAuth grant
 * server-side (code+state → provider exchange → verified identity) and never
 * trust a client-supplied profile. A prior version accepted `oauthData.{id,email}`
 * straight from the body, letting anyone holding an invite token bind the
 * invitee's email to an attacker-chosen account (org/account takeover).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAcceptViaOAuth = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const mockVerifyOAuthCode = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, _data: unknown, message?: string) => res.status(status).json({ success: true, message }),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({ config: {} }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({ validateBody: jest.fn(), sendInvitationSchema: {} }));

jest.unstable_mockModule('../src/controllers/oauth.js', () => ({
  verifyOAuthCode: (...a: unknown[]) => mockVerifyOAuthCode(...a),
  OAUTH_ERROR_MAP: {
    OAUTH_UNSUPPORTED_PROVIDER: { status: 400, message: 'Unsupported OAuth provider' },
    OAUTH_INVALID_STATE: { status: 403, message: 'Invalid or expired OAuth state' },
    OAUTH_NO_EMAIL: { status: 400, message: 'OAuth provider did not return an email address' },
    TOKEN_EXCHANGE_FAILED: { status: 502, message: 'Failed to exchange authorization code' },
  },
}));

// withController applies the error map to thrown Error(message) — mirror the real one.
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireOrgMembership: jest.fn(),
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try { return await fn(req, res); } catch (e: any) {
        const mapped = errorMap?.[e?.message];
        if (mapped) return res.status(mapped.status).json({ success: false, message: mapped.message });
        return res.status(500).json({ success: false, message: e?.message });
      }
    },
}));

const INV = [
  'INV_ORG_NOT_FOUND', 'INV_UNAUTHORIZED', 'INV_ALREADY_MEMBER', 'INV_ALREADY_SENT', 'INV_MAX_REACHED',
  'INV_SEAT_LIMIT', 'INV_INVITER_NOT_FOUND', 'INV_NOT_FOUND', 'INV_ACCEPTED', 'INV_EXPIRED', 'INV_REVOKED',
  'INV_USER_NOT_FOUND', 'INV_EMAIL_MISMATCH', 'INV_OAUTH_NOT_ALLOWED', 'INV_EMAIL_NOT_ALLOWED', 'INV_NOT_PENDING',
];
jest.unstable_mockModule('../src/services/index.js', () => ({
  invitationService: { acceptViaOAuth: (...a: unknown[]) => mockAcceptViaOAuth(...a) },
  ...Object.fromEntries(INV.map((k) => [k, k])),
}));

const { acceptInvitationViaOAuth } = await import('../src/controllers/invitation.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('acceptInvitationViaOAuth (server-side verification)', () => {
  beforeEach(() => { jest.clearAllMocks(); mockAcceptViaOAuth.mockResolvedValue(undefined); });

  it('rejects (400) when code/state are missing — no client-supplied profile accepted', async () => {
    const res = makeRes();
    // Even with a fully-formed (attacker) oauthData, absent code/state → rejected.
    await acceptInvitationViaOAuth({ body: { token: 't', oauthProvider: 'google', oauthData: { id: 'x', email: 'victim@x.com' } } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockVerifyOAuthCode).not.toHaveBeenCalled();
    expect(mockAcceptViaOAuth).not.toHaveBeenCalled();
  });

  it('rejects (400) an unsupported provider', async () => {
    const res = makeRes();
    await acceptInvitationViaOAuth({ body: { token: 't', oauthProvider: 'facebook', code: 'c', state: 's' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockVerifyOAuthCode).not.toHaveBeenCalled();
  });

  it('exchanges code+state and passes the SERVER-VERIFIED identity to the service', async () => {
    mockVerifyOAuthCode.mockResolvedValue({ id: 'google-real-123', email: 'invitee@x.com', name: 'Real' });
    const res = makeRes();
    // Attacker also smuggles oauthData in the body — it must be ignored entirely.
    await acceptInvitationViaOAuth({
      body: { token: 'tok', oauthProvider: 'google', code: 'auth-code', state: 'csrf-state', oauthData: { id: 'ATTACKER', email: 'invitee@x.com' } },
    } as any, res);

    expect(mockVerifyOAuthCode).toHaveBeenCalledWith('google', 'auth-code', 'csrf-state');
    expect(mockAcceptViaOAuth).toHaveBeenCalledWith('tok', 'google', { id: 'google-real-123', email: 'invitee@x.com', name: 'Real' });
    // Never the attacker-supplied id.
    expect(mockAcceptViaOAuth).not.toHaveBeenCalledWith('tok', 'google', expect.objectContaining({ id: 'ATTACKER' }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('maps a failed state check to 403 and never touches the service', async () => {
    mockVerifyOAuthCode.mockRejectedValue(new Error('OAUTH_INVALID_STATE'));
    const res = makeRes();
    await acceptInvitationViaOAuth({ body: { token: 't', oauthProvider: 'google', code: 'c', state: 'bad' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAcceptViaOAuth).not.toHaveBeenCalled();
  });
});
