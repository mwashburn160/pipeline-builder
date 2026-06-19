// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, test } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    auth: {
      jwt: { secret: 'test-secret', algorithm: 'HS256', expiresIn: 3600 },
      refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
      passwordMinLength: 8,
    },
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: jest.fn(),
  // Consumed transitively via token.js -> org-hierarchy.js.
  resolveUserFeatures: jest.fn(() => ({})),
  resolveOrgLineageWith: jest.fn(),
  isAncestorOrgWith: jest.fn(),
  expandOrgScopeWith: jest.fn(),
  toOrgIdString: (id: unknown) => String(id),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    }),
  },
  User: {},
  UserOrganization: {},
}));

const { hashRefreshToken, issueStepUpToken, verifyStepUpToken } = await import('../src/utils/token.js');
const { validateBody, registerSchema, loginSchema, refreshSchema } = await import('../src/utils/validation.js');
const { sendError: mockSendErrorFn } = await import('@pipeline-builder/api-core');
const mockSendError = mockSendErrorFn as jest.MockedFunction<typeof mockSendErrorFn>;

describe('step-up token (requireStepUp gate)', () => {
  it('accepts a freshly issued step-up token', () => {
    const { token } = issueStepUpToken('user-1', 60);
    const payload = verifyStepUpToken(token);
    expect(payload.type).toBe('step-up');
    expect(payload.sub).toBe('user-1');
  });

  it('rejects a normal access token (same secret/sub, no step-up type) — the bypass', () => {
    // A regular access token shares the JWT secret + sub; without the type check
    // it would satisfy the password re-verification gate on destructive routes.
    const access = jwt.sign({ sub: 'user-1' }, 'test-secret', { algorithm: 'HS256', expiresIn: 60 });
    expect(() => verifyStepUpToken(access)).toThrow();
  });
});


describe('auth-utils schemas', () => {
  describe('registerSchema', () => {
    it('should accept valid registration', () => {
      const result = registerSchema.safeParse({
        username: 'testuser',
        email: 'test@example.com',
        password: 'Password1',
      });
      expect(result.success).toBe(true);
    });

    it('should reject short username', () => {
      const result = registerSchema.safeParse({
        username: 'a',
        email: 'test@example.com',
        password: 'Password1',
      });
      expect(result.success).toBe(false);
    });

    it('should reject short password', () => {
      const result = registerSchema.safeParse({
        username: 'testuser',
        email: 'test@example.com',
        password: 'short',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('should accept valid login', () => {
      expect(loginSchema.safeParse({ identifier: 'user', password: 'pass' }).success).toBe(true);
    });

    it('should reject empty identifier', () => {
      expect(loginSchema.safeParse({ identifier: '', password: 'pass' }).success).toBe(false);
    });
  });

  describe('refreshSchema', () => {
    it('should accept valid token', () => {
      expect(refreshSchema.safeParse({ refreshToken: 'some-token' }).success).toBe(true);
    });

    it('should reject empty token', () => {
      expect(refreshSchema.safeParse({ refreshToken: '' }).success).toBe(false);
    });
  });
});

describe('hashRefreshToken', () => {
  it('should produce consistent SHA-256 hash', () => {
    const hash1 = hashRefreshToken('my-token');
    const hash2 = hashRefreshToken('my-token');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('should differ for different tokens', () => {
    expect(hashRefreshToken('a')).not.toBe(hashRefreshToken('b'));
  });
});

describe('validateBody (auth-utils version)', () => {
  it('should return parsed data for valid input', () => {
    const res = {} as any;
    const result = validateBody(loginSchema, { identifier: 'user', password: 'pass' }, res);
    expect(result).toEqual({ identifier: 'user', password: 'pass' });
  });

  it('should return null and send error for invalid input', () => {
    mockSendError.mockClear();
    const res = {} as any;

    const result = validateBody(loginSchema, {}, res);
    expect(result).toBeNull();
    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('should include field path in error message', () => {
    mockSendError.mockClear();
    const res = {} as any;

    validateBody(loginSchema, { identifier: '', password: 'pass' }, res);

    const errorMsg = mockSendError.mock.calls[0][2];
    expect(errorMsg).toContain('identifier');
  });
});
