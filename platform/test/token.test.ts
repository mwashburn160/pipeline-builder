// ---------------------------------------------------------------------------
// Mock config and models before importing
// ---------------------------------------------------------------------------
jest.mock('../src/config', () => ({
  config: {
    auth: {
      passwordMinLength: 8,
      jwt: {
        secret: 'test-jwt-secret',
        expiresIn: 7200,
        algorithm: 'HS256',
        saltRounds: 12,
      },
      refreshToken: {
        secret: 'test-refresh-secret',
        expiresIn: 2592000,
      },
    },
  },
}));

jest.mock('../src/models', () => ({
  User: {
    updateOne: jest.fn().mockResolvedValue({}),
  },
}));

import jwt from 'jsonwebtoken';
import {
  createAccessTokenPayload,
  createRefreshTokenPayload,
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  hashRefreshToken,
  issueTokens,
  verifyAccessToken,
  verifyRefreshToken,
} from '../src/utils/token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockUser(overrides: Partial<{
  _id: { toString(): string };
  username: string;
  email: string;
  role: string;
  isEmailVerified: boolean;
  organizationId: { toString(): string } | string;
  tokenVersion: number;
}> = {}) {
  return {
    _id: overrides._id || { toString: () => 'user-123' },
    username: overrides.username || 'testuser',
    email: overrides.email || 'test@example.com',
    role: overrides.role || 'user',
    isEmailVerified: overrides.isEmailVerified ?? true,
    organizationId: 'organizationId' in overrides ? overrides.organizationId : { toString: () => 'org-456' },
    tokenVersion: overrides.tokenVersion ?? 1,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('token utilities', () => {
  describe('createAccessTokenPayload', () => {
    it('should build payload from user document', () => {
      const user = mockUser();
      const payload = createAccessTokenPayload(user);

      expect(payload.type).toBe('access');
      expect(payload.sub).toBe('user-123');
      expect(payload.username).toBe('testuser');
      expect(payload.email).toBe('test@example.com');
      expect(payload.role).toBe('user');
      expect(payload.isAdmin).toBe(false);
      expect(payload.organizationId).toBe('org-456');
      expect(payload.tokenVersion).toBe(1);
      expect(payload.isEmailVerified).toBe(true);
    });

    it('should set isAdmin=true for admin role', () => {
      const user = mockUser({ role: 'admin' });
      const payload = createAccessTokenPayload(user);
      expect(payload.isAdmin).toBe(true);
    });

    it('should handle undefined organizationId', () => {
      const user = mockUser({ organizationId: undefined as any });
      const payload = createAccessTokenPayload(user);
      expect(payload.organizationId).toBeUndefined();
    });
  });

  describe('createRefreshTokenPayload', () => {
    it('should build minimal refresh payload', () => {
      const user = mockUser();
      const payload = createRefreshTokenPayload(user);

      expect(payload.type).toBe('refresh');
      expect(payload.sub).toBe('user-123');
      expect(payload.tokenVersion).toBe(1);
      expect(Object.keys(payload)).toEqual(['type', 'sub', 'tokenVersion']);
    });
  });

  describe('generateAccessToken', () => {
    it('should return a valid JWT string', () => {
      const token = generateAccessToken(mockUser());
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should contain expected payload when decoded', () => {
      const token = generateAccessToken(mockUser());
      const decoded = jwt.decode(token) as any;

      expect(decoded.type).toBe('access');
      expect(decoded.sub).toBe('user-123');
      expect(decoded.username).toBe('testuser');
      expect(decoded.exp).toBeDefined();
    });
  });

  describe('generateRefreshToken', () => {
    it('should return a valid JWT string', () => {
      const token = generateRefreshToken(mockUser());
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should contain refresh type in payload', () => {
      const token = generateRefreshToken(mockUser());
      const decoded = jwt.decode(token) as any;

      expect(decoded.type).toBe('refresh');
      expect(decoded.sub).toBe('user-123');
    });
  });

  describe('generateTokenPair', () => {
    it('should return both access and refresh tokens', () => {
      const { accessToken, refreshToken } = generateTokenPair(mockUser());

      expect(typeof accessToken).toBe('string');
      expect(typeof refreshToken).toBe('string');

      const accessDecoded = jwt.decode(accessToken) as any;
      const refreshDecoded = jwt.decode(refreshToken) as any;

      expect(accessDecoded.type).toBe('access');
      expect(refreshDecoded.type).toBe('refresh');
    });
  });

  describe('hashRefreshToken', () => {
    it('should return a hex SHA-256 hash', () => {
      const hash = hashRefreshToken('my-refresh-token');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent hashes', () => {
      const hash1 = hashRefreshToken('token-value');
      const hash2 = hashRefreshToken('token-value');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashRefreshToken('token-a');
      const hash2 = hashRefreshToken('token-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyAccessToken', () => {
    it('should verify a valid access token', () => {
      const token = generateAccessToken(mockUser());
      const payload = verifyAccessToken(token);

      expect(payload.type).toBe('access');
      expect(payload.sub).toBe('user-123');
    });

    it('should throw for an invalid token', () => {
      expect(() => verifyAccessToken('invalid.token.here')).toThrow();
    });

    it('should throw for a token signed with wrong secret', () => {
      const token = jwt.sign({ type: 'access', sub: '123' }, 'wrong-secret');
      expect(() => verifyAccessToken(token)).toThrow();
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify a valid refresh token', () => {
      const token = generateRefreshToken(mockUser());
      const payload = verifyRefreshToken(token);

      expect(payload.type).toBe('refresh');
      expect(payload.sub).toBe('user-123');
    });

    it('should throw for invalid token', () => {
      expect(() => verifyRefreshToken('bad-token')).toThrow();
    });
  });

  describe('issueTokens', () => {
    it('should generate tokens and persist hash to DB', async () => {
      const { User } = jest.requireMock('../src/models');
      const user = mockUser();

      const result = await issueTokens(user);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(User.updateOne).toHaveBeenCalledWith(
        { _id: user._id },
        { $set: { refreshToken: expect.stringMatching(/^[0-9a-f]{64}$/) } },
      );
    });
  });
});
