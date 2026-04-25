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
