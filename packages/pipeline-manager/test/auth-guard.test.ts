// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { decodeTokenPayload } from '../src/utils/auth-guard';

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-signature`;
}

describe('decodeTokenPayload', () => {
  it('should decode a valid JWT payload', () => {
    const token = fakeJwt({ role: 'admin', sub: 'user-123' });
    const payload = decodeTokenPayload(token);
    expect(payload).toEqual(expect.objectContaining({ role: 'admin', sub: 'user-123' }));
  });

  it('should return null for invalid token format', () => {
    expect(decodeTokenPayload('not-a-jwt')).toBeNull();
    expect(decodeTokenPayload('')).toBeNull();
  });

  it('should return null for malformed base64', () => {
    expect(decodeTokenPayload('a.!!!invalid!!!.c')).toBeNull();
  });

  it('should handle tokens with extra fields', () => {
    const token = fakeJwt({ role: 'user', organizationId: 'org-1', isAdmin: false });
    const payload = decodeTokenPayload(token);
    expect(payload?.role).toBe('user');
    expect(payload?.organizationId).toBe('org-1');
    expect(payload?.isAdmin).toBe(false);
  });
});
