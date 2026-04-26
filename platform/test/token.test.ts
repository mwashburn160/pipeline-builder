// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock config and models before importing
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

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: jest.fn(actual.randomBytes),
  };
});

import jwt from 'jsonwebtoken';
import {
  hashRefreshToken,
  issueTokens,
  verifyAccessToken,
  verifyRefreshToken,
} from '../src/utils/token';

// Helpers
function mockUser(overrides: Partial<{
  _id: { toString(): string };
  username: string;
  email: string;
  isEmailVerified: boolean;
  lastActiveOrgId: { toString(): string } | string;
  tokenVersion: number;
}> = {}) {
  return {
    _id: overrides._id || { toString: () => 'user-123' },
    username: overrides.username || 'testuser',
    email: overrides.email || 'test@example.com',
    isEmailVerified: overrides.isEmailVerified ?? true,
    lastActiveOrgId: 'lastActiveOrgId' in overrides ? overrides.lastActiveOrgId : { toString: () => 'org-456' },
    tokenVersion: overrides.tokenVersion ?? 1,
  } as any;
}

// Tests

describe('token utilities', () => {
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
    it('should verify a valid access token', async () => {
      const { accessToken } = await issueTokens(mockUser());
      const payload = verifyAccessToken(accessToken);

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
    it('should verify a valid refresh token', async () => {
      const { refreshToken } = await issueTokens(mockUser());
      const payload = verifyRefreshToken(refreshToken);

      expect(payload.type).toBe('refresh');
      expect(payload.sub).toBe('user-123');
    });

    it('should throw for invalid token', () => {
      expect(() => verifyRefreshToken('bad-token')).toThrow();
    });
  });

  describe('issueTokens', () => {
    it('should generate tokens and persist hash + token-history record to DB', async () => {
      const { User } = jest.requireMock('../src/models');
      const user = mockUser();

      const result = await issueTokens(user);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(User.updateOne).toHaveBeenCalledWith(
        { _id: user._id },
        expect.objectContaining({
          $set: { refreshToken: expect.stringMatching(/^[0-9a-f]{64}$/) },
          $push: {
            issuedTokens: {
              $each: [expect.objectContaining({
                id: expect.stringMatching(/^[0-9a-f]{16}$/),
                createdAt: expect.any(Date),
                expiresAt: expect.any(Date),
                tokenVersionAtIssue: 1,
              })],
              $slice: -20,
            },
          },
        }),
      );
    });

    it('records the token version at time of issuance', async () => {
      const { User } = jest.requireMock('../src/models');
      const user = mockUser({ tokenVersion: 7 });
      await issueTokens(user);
      const call = User.updateOne.mock.calls.at(-1)?.[1];
      expect(call.$push.issuedTokens.$each[0].tokenVersionAtIssue).toBe(7);
    });

    it('records expiresAt aligned to the JWT exp claim', async () => {
      const { User } = jest.requireMock('../src/models');
      const before = Date.now();
      await issueTokens(mockUser(), undefined, 600);
      const call = User.updateOne.mock.calls.at(-1)?.[1];
      const recordedExpiresMs = (call.$push.issuedTokens.$each[0].expiresAt as Date).getTime();
      // Within 2 seconds of expected window (test execution jitter).
      expect(Math.abs(recordedExpiresMs - (before + 600 * 1000))).toBeLessThan(2000);
    });

    it('should default access-token expiresIn to config value when override is omitted', async () => {
      const { accessToken, expiresIn } = await issueTokens(mockUser());
      expect(expiresIn).toBe(7200); // matches mocked config.auth.jwt.expiresIn
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(7200);
    });

    it('should honor a custom expiresIn override (regression: --days 30 from store-token CLI)', async () => {
      const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, THIRTY_DAYS_SEC);
      expect(expiresIn).toBe(THIRTY_DAYS_SEC);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(THIRTY_DAYS_SEC);
    });

    it('should honor a 90-day expiresIn override', async () => {
      const NINETY_DAYS_SEC = 90 * 24 * 60 * 60;
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, NINETY_DAYS_SEC);
      expect(expiresIn).toBe(NINETY_DAYS_SEC);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(NINETY_DAYS_SEC);
    });

    it('should honor a 365-day expiresIn override (CLI cap)', async () => {
      const ONE_YEAR_SEC = 365 * 24 * 60 * 60;
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, ONE_YEAR_SEC);
      expect(expiresIn).toBe(ONE_YEAR_SEC);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(ONE_YEAR_SEC);
    });

    it('should accept short custom expiresIn (e.g. 1 hour)', async () => {
      const { accessToken } = await issueTokens(mockUser(), undefined, 3600);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(3600);
    });
  });
});
