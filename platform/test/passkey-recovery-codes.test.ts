// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkeys and the account's recovery codes (controllers/webauthn.ts):
 *   - registering the account's FIRST second factor as a passkey mints the
 *     recovery-code set and returns it once; a later passkey keeps the set;
 *   - enrolling ends any MFA-reset enrolment grace, AND any "don't ask again"
 *     the person gave the password-only prompt — otherwise removing this
 *     passkey later would leave them silently un-nudged;
 *   - removing the LAST factor takes the recovery codes with it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const mockAudit = jest.fn<AnyFn>();
const mockIssue = jest.fn<(...a: unknown[]) => Promise<string[] | null>>();
const mockRemoveIfNone = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockClearGrace = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => false);
const mockClearNudge = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const passkey = { id: 'pk1', name: 'Laptop', backedUp: false };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({ closeBootstrapExceptionOnEnrolment: jest.fn(async () => undefined), isBootstrapSuperAdminEmail: () => false }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/services/webauthn-service.js', () => ({
  verifyRegistration: jest.fn(async () => passkey),
  removeCredential: jest.fn(async () => passkey),
}));
jest.unstable_mockModule('../src/services/recovery-codes-service.js', () => ({
  issueRecoveryCodesIfAbsent: (...a: unknown[]) => mockIssue(...a),
  removeRecoveryCodesIfNoFactor: (...a: unknown[]) => mockRemoveIfNone(...a),
}));
jest.unstable_mockModule('../src/services/mfa-enrolment.js', () => ({
  clearResetGraceOnEnrolment: (...a: unknown[]) => mockClearGrace(...a),
  clearMfaNudgeOnEnrolment: (...a: unknown[]) => mockClearNudge(...a),
}));

const { registerVerify, removePasskey } = await import('../src/controllers/webauthn.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}
const USER = '651111111111111111111111';
const registerBody = { ceremonyId: 'c1', name: 'Laptop', response: { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'a', attestationObject: 'b' }, clientExtensionResults: {} } };

beforeEach(() => { jest.clearAllMocks(); });

describe('registering a passkey', () => {
  it('returns the recovery codes when it is the account\'s first second factor', async () => {
    mockIssue.mockResolvedValue(['AAAAA-BBBBB']);
    const res = makeRes();
    await registerVerify({ user: { sub: USER }, body: registerBody, headers: {} } as any, res);
    expect(res._status).toBe(201);
    expect(res._body.data).toEqual({ passkey, recoveryCodes: ['AAAAA-BBBBB'] });
    expect(mockIssue).toHaveBeenCalledWith(USER);
    expect(mockClearGrace).toHaveBeenCalledWith(USER);
    // A factor exists now, so any "don't ask again" on the password-only prompt
    // is cleared — removing this passkey later must prompt them again rather
    // than leave a decline they made before they had one still silencing it.
    expect(mockClearNudge).toHaveBeenCalledWith(USER);
  });

  it('keeps the existing set (and returns none) for a later passkey', async () => {
    mockIssue.mockResolvedValue(null);
    const res = makeRes();
    await registerVerify({ user: { sub: USER }, body: registerBody, headers: {} } as any, res);
    expect(res._body.data).toEqual({ passkey });
  });
});

describe('removing a passkey', () => {
  it('drops the recovery codes with the last factor, and says so in the audit', async () => {
    mockRemoveIfNone.mockResolvedValue(true);
    const res = makeRes();
    await removePasskey({ user: { sub: USER }, params: { id: 'pk1' }, headers: {} } as any, res);
    expect(res._status).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.passkey.remove', expect.objectContaining({
      details: expect.objectContaining({ recoveryCodesRemoved: true }),
    }));
  });

  it('leaves them while another factor remains', async () => {
    mockRemoveIfNone.mockResolvedValue(false);
    const res = makeRes();
    await removePasskey({ user: { sub: USER }, params: { id: 'pk1' }, headers: {} } as any, res);
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ details: { passkeyId: 'pk1', name: 'Laptop' } });
    expect((mockAudit.mock.calls[0][2] as any).details.recoveryCodesRemoved).toBeUndefined();
  });
});
