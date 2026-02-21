jest.mock('../src/config', () => ({
  config: {
    auth: {
      jwt: { secret: 'test-secret', expiresIn: 3600 },
      refreshToken: { secret: 'test-refresh-secret', expiresIn: 86400 },
      passwordMinLength: 8,
    },
  },
}));

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  sendError: jest.fn(),
}));

jest.mock('../src/models', () => ({
  Organization: {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    }),
  },
}));

import {
  registerSchema,
  loginSchema,
  refreshSchema,
  hashRefreshToken,
  validateBody,
} from '../src/utils/auth-utils';

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
        username: 'ab',
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
    const mockSendError = jest.requireMock('@mwashburn160/api-core').sendError;
    mockSendError.mockClear();
    const res = {} as any;

    const result = validateBody(loginSchema, {}, res);
    expect(result).toBeNull();
    expect(mockSendError).toHaveBeenCalledWith(res, 400, expect.any(String), 'VALIDATION_ERROR');
  });

  it('should include field path in error message', () => {
    const mockSendError = jest.requireMock('@mwashburn160/api-core').sendError;
    mockSendError.mockClear();
    const res = {} as any;

    validateBody(loginSchema, { identifier: '', password: 'pass' }, res);

    const errorMsg = mockSendError.mock.calls[0][2];
    expect(errorMsg).toContain('identifier');
  });
});
