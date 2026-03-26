import { decodeTokenPayload, warnIfNotAdmin } from '../src/utils/auth-guard';

// Mock output-utils
jest.mock('../src/utils/output-utils', () => ({
  printWarning: jest.fn(),
}));

const { printWarning } = jest.requireMock('../src/utils/output-utils');

// Helper: create a fake JWT with given payload (no signature verification)
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

describe('warnIfNotAdmin', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should not warn for admin role', () => {
    const token = fakeJwt({ role: 'admin' });
    warnIfNotAdmin(token);
    expect(printWarning).not.toHaveBeenCalled();
  });

  it('should not warn for owner role', () => {
    const token = fakeJwt({ role: 'owner' });
    warnIfNotAdmin(token);
    expect(printWarning).not.toHaveBeenCalled();
  });

  it('should warn for non-admin role', () => {
    const token = fakeJwt({ role: 'user' });
    warnIfNotAdmin(token);
    expect(printWarning).toHaveBeenCalledWith(
      expect.stringContaining('does not appear to have admin role'),
    );
  });

  it('should warn for invalid token but not throw', () => {
    warnIfNotAdmin('invalid-token');
    expect(printWarning).toHaveBeenCalledWith(
      expect.stringContaining('Unable to decode token'),
    );
  });
});
