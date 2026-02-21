import type { HttpRequest } from '../src/types/http';
import { getIdentity, validateIdentity } from '../src/utils/identity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    headers: {},
    params: {},
    query: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getIdentity', () => {
  it('should extract identity from headers', () => {
    const req = mockRequest({
      headers: {
        'x-org-id': 'org-1',
        'x-user-id': 'user-1',
        'x-request-id': 'req-123',
        'x-user-role': 'admin',
      },
    });
    const identity = getIdentity(req);
    expect(identity.orgId).toBe('org-1');
    expect(identity.userId).toBe('user-1');
    expect(identity.requestId).toBe('req-123');
    expect(identity.role).toBe('admin');
  });

  it('should prefer JWT claims (req.user) over headers', () => {
    const req = mockRequest({
      headers: {
        'x-org-id': 'header-org',
        'x-user-id': 'header-user',
        'x-user-role': 'user',
      },
      user: {
        organizationId: 'jwt-org',
        userId: 'jwt-user',
        role: 'admin',
      },
    });
    const identity = getIdentity(req);
    expect(identity.orgId).toBe('jwt-org');
    expect(identity.userId).toBe('jwt-user');
    expect(identity.role).toBe('admin');
  });

  it('should fall back to headers when user fields are missing', () => {
    const req = mockRequest({
      headers: {
        'x-org-id': 'header-org',
        'x-user-id': 'header-user',
      },
      user: {},
    });
    const identity = getIdentity(req);
    expect(identity.orgId).toBe('header-org');
    expect(identity.userId).toBe('header-user');
  });

  it('should return requestId only from header (not in JWT)', () => {
    const req = mockRequest({
      headers: { 'x-request-id': 'trace-456' },
      user: { organizationId: 'org-1' },
    });
    const identity = getIdentity(req);
    expect(identity.requestId).toBe('trace-456');
  });

  it('should return undefined for missing fields', () => {
    const req = mockRequest();
    const identity = getIdentity(req);
    expect(identity.orgId).toBeUndefined();
    expect(identity.userId).toBeUndefined();
    expect(identity.requestId).toBeUndefined();
    expect(identity.role).toBeUndefined();
  });
});

describe('validateIdentity', () => {
  it('should pass when all required fields are present', () => {
    const identity = { orgId: 'org-1', userId: 'user-1', requestId: 'req-1', role: 'admin' };
    const result = validateIdentity(identity, ['orgId', 'userId']);
    expect(result.isValid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('should fail when required fields are missing', () => {
    const identity = { orgId: 'org-1' };
    const result = validateIdentity(identity, ['orgId', 'userId']);
    expect(result.isValid).toBe(false);
    expect(result.missing).toContain('x-user-id');
  });

  it('should report all missing fields', () => {
    const identity = {};
    const result = validateIdentity(identity, ['orgId', 'userId', 'requestId']);
    expect(result.isValid).toBe(false);
    expect(result.missing).toHaveLength(3);
    expect(result.missing).toContain('x-org-id');
    expect(result.missing).toContain('x-user-id');
    expect(result.missing).toContain('x-request-id');
  });

  it('should pass with no required fields', () => {
    const result = validateIdentity({}, []);
    expect(result.isValid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('should convert camelCase field names to header format', () => {
    const identity = {};
    const result = validateIdentity(identity, ['requestId']);
    expect(result.missing).toContain('x-request-id');
  });
});
