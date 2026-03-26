jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  loadServerConfig,
  loadAuthConfig,
  loadRateLimitConfig,
  validateServerConfig,
  validateAuthConfig,
} from '../src/config/server-config';

describe('loadServerConfig', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns correct defaults', () => {
    delete process.env.PORT;
    delete process.env.CORS_ORIGIN;
    delete process.env.CORS_CREDENTIALS;
    delete process.env.TRUST_PROXY;
    delete process.env.PLATFORM_BASE_URL;
    delete process.env.PLUGIN_SERVICE_HOST;
    delete process.env.PLUGIN_SERVICE_PORT;

    const config = loadServerConfig();

    expect(config.port).toBe(3000);
    expect(config.cors.credentials).toBe(true);
    expect(config.trustProxy).toBe(1);
    expect(config.platformUrl).toBe('https://localhost:8443');
    expect(config.services.pluginHost).toBe('plugin');
    expect(config.services.pluginPort).toBe(3000);
  });

  it('parses CORS_ORIGIN as comma-separated list', () => {
    process.env.CORS_ORIGIN = 'https://a.com, https://b.com, https://c.com';

    const config = loadServerConfig();

    expect(config.cors.origin).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('disables credentials when CORS_CREDENTIALS=false', () => {
    process.env.CORS_CREDENTIALS = 'false';

    const config = loadServerConfig();

    expect(config.cors.credentials).toBe(false);
  });

  it('overrides port and trust proxy from env', () => {
    process.env.PORT = '8080';
    process.env.TRUST_PROXY = '2';

    const config = loadServerConfig();

    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(2);
  });
});

describe('loadAuthConfig', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns empty secret when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    process.env.REFRESH_TOKEN_SECRET = 'refresh-secret';

    const config = loadAuthConfig();
    expect(config.jwt.secret).toBe('');
  });

  it('returns empty secret when REFRESH_TOKEN_SECRET is missing', () => {
    process.env.JWT_SECRET = 'jwt-secret';
    delete process.env.REFRESH_TOKEN_SECRET;

    const config = loadAuthConfig();
    expect(config.refreshToken.secret).toBe('');
  });

  it('returns correct values from env', () => {
    process.env.JWT_SECRET = 'my-jwt-secret';
    process.env.REFRESH_TOKEN_SECRET = 'my-refresh-secret';
    process.env.JWT_EXPIRES_IN = '3600';
    process.env.JWT_ALGORITHM = 'HS384';
    process.env.JWT_SALT_ROUNDS = '14';
    process.env.REFRESH_TOKEN_EXPIRES_IN = '86400';

    const config = loadAuthConfig();

    expect(config.jwt.secret).toBe('my-jwt-secret');
    expect(config.jwt.expiresIn).toBe(3600);
    expect(config.jwt.algorithm).toBe('HS384');
    expect(config.jwt.saltRounds).toBe(14);
    expect(config.refreshToken.secret).toBe('my-refresh-secret');
    expect(config.refreshToken.expiresIn).toBe(86400);
  });

  it('uses defaults when optional env vars are not set', () => {
    process.env.JWT_SECRET = 'my-jwt-secret';
    process.env.REFRESH_TOKEN_SECRET = 'my-refresh-secret';
    delete process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_ALGORITHM;
    delete process.env.JWT_SALT_ROUNDS;
    delete process.env.REFRESH_TOKEN_EXPIRES_IN;

    const config = loadAuthConfig();

    expect(config.jwt.expiresIn).toBe(7200);
    expect(config.jwt.algorithm).toBe('HS256');
    expect(config.jwt.saltRounds).toBe(12);
    expect(config.refreshToken.expiresIn).toBe(2592000);
  });
});

describe('loadRateLimitConfig', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns correct defaults', () => {
    delete process.env.LIMITER_MAX;
    delete process.env.LIMITER_WINDOWMS;

    const config = loadRateLimitConfig();

    expect(config.max).toBe(100);
    expect(config.windowMs).toBe(900000);
    expect(config.legacyHeaders).toBe(false);
    expect(config.standardHeaders).toBe(true);
  });

  it('overrides from env', () => {
    process.env.LIMITER_MAX = '50';
    process.env.LIMITER_WINDOWMS = '60000';

    const config = loadRateLimitConfig();

    expect(config.max).toBe(50);
    expect(config.windowMs).toBe(60000);
  });
});

describe('validateServerConfig', () => {
  const defaultHttpClient = { timeout: 5000, maxRetries: 2, retryDelayMs: 200 };
  const defaultSse = { maxClientsPerRequest: 10, clientTimeoutMs: 1800000, cleanupIntervalMs: 300000 };
  const defaultServices = { pluginHost: 'plugin', pluginPort: 3000 };

  it('does not throw for valid config', () => {
    expect(() =>
      validateServerConfig({
        port: 3000,
        cors: { credentials: true, origin: ['https://example.com'] },
        trustProxy: 1,
        platformUrl: 'https://example.com',
        httpClient: defaultHttpClient,
        sse: defaultSse,
        services: defaultServices,
      }),
    ).not.toThrow();
  });

  it('throws on wildcard CORS with credentials enabled', () => {
    expect(() =>
      validateServerConfig({
        port: 3000,
        cors: { credentials: true, origin: '*' },
        trustProxy: 1,
        platformUrl: 'https://example.com',
        httpClient: defaultHttpClient,
        sse: defaultSse,
        services: defaultServices,
      }),
    ).toThrow('SECURITY ERROR');
  });

  it('does not throw on wildcard CORS without credentials (only warns)', () => {
    expect(() =>
      validateServerConfig({
        port: 3000,
        cors: { credentials: false, origin: '*' },
        trustProxy: 1,
        platformUrl: 'https://example.com',
        httpClient: defaultHttpClient,
        sse: defaultSse,
        services: defaultServices,
      }),
    ).not.toThrow();
  });

  it('does not throw on non-HTTPS platform URL (only warns)', () => {
    expect(() =>
      validateServerConfig({
        port: 3000,
        cors: { credentials: true, origin: ['https://example.com'] },
        trustProxy: 1,
        platformUrl: 'http://example.com',
        httpClient: defaultHttpClient,
        sse: defaultSse,
        services: defaultServices,
      }),
    ).not.toThrow();
  });

  it('allows http://localhost without warning', () => {
    expect(() =>
      validateServerConfig({
        port: 3000,
        cors: { credentials: true, origin: ['http://localhost:3000'] },
        trustProxy: 1,
        platformUrl: 'http://localhost:8443',
        httpClient: defaultHttpClient,
        sse: defaultSse,
        services: defaultServices,
      }),
    ).not.toThrow();
  });
});

describe('validateAuthConfig', () => {
  const validConfig = {
    jwt: {
      secret: 'xK9mQ7vLpR2nW8jF4hT6bY0cA3eG5iUo',
      expiresIn: 3600,
      algorithm: 'HS256' as const,
      saltRounds: 12,
    },
    refreshToken: {
      secret: 'zN1dS8wM4qJ7rX0fV3kL6yP9tB2uH5gE',
      expiresIn: 2592000,
    },
  };

  it('does not throw for valid config', () => {
    expect(() => validateAuthConfig(validConfig)).not.toThrow();
  });

  it('throws for insecure JWT secret', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: 'default-insecure-secret-that-is-long' },
      }),
    ).toThrow('Auth configuration validation failed');
  });

  it('throws for short JWT secret (< 32 chars)', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: 'tooshort' },
      }),
    ).toThrow('at least 32 characters');
  });

  it('throws for short refresh token secret (< 32 chars)', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        refreshToken: { ...validConfig.refreshToken, secret: 'tooshort' },
      }),
    ).toThrow('at least 32 characters');
  });

  it('throws for disallowed algorithm', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, algorithm: 'none' as any },
      }),
    ).toThrow('not in the allowed list');
  });

  it('does not throw when JWT expiration > 2h (only warns)', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, expiresIn: 86400 },
      }),
    ).not.toThrow();
  });

  // --- Fix 24: JWT expiration hard limit at 86400 seconds ---

  it('throws when JWT expiration exceeds 24h hard limit (> 86400)', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, expiresIn: 86401 },
      }),
    ).toThrow('must not exceed 24 hours');
  });

  it('throws when JWT expiration is far beyond the hard limit', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, expiresIn: 604800 }, // 7 days
      }),
    ).toThrow('must not exceed 24 hours');
  });

  it('does not throw at exactly 86400 seconds (boundary)', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, expiresIn: 86400 },
      }),
    ).not.toThrow();
  });

  it('warns but does not throw when JWT expiration is between 2h and 24h', () => {
    // 14400 = 4 hours, which is > 7200 but <= 86400
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, expiresIn: 14400 },
      }),
    ).not.toThrow();
  });

  it('does not warn or throw when JWT expiration is at or below 2h', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, expiresIn: 7200 },
      }),
    ).not.toThrow();
  });

  // --- Fix 25: Secret validation with length threshold ---

  it('does not flag long secrets (>= 64 chars) that contain insecure substrings', () => {
    // A 64+ character secret that happens to contain "password" should NOT be flagged
    // because long secrets are likely generated and secure despite containing common substrings
    const longSecretWithPassword =
      'aB3dEfGhIjKlMnOpQrStUvWxYz0123456789passwordABCDEFGHIJKLMNOPQRSTUV';

    expect(longSecretWithPassword.length).toBeGreaterThanOrEqual(64);
    expect(longSecretWithPassword.toLowerCase()).toContain('password');

    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: longSecretWithPassword },
      }),
    ).not.toThrow();
  });

  it('does not flag long refresh token secrets (>= 64 chars) containing insecure substrings', () => {
    const longRefreshSecret =
      'xR9kW2mN5pQ8sT1vY4bE7gJ0lO3fU6hA9cdefaultI2dK5nP8rS1uX4aD7eH0jM3';

    expect(longRefreshSecret.length).toBeGreaterThanOrEqual(64);
    expect(longRefreshSecret.toLowerCase()).toContain('default');

    expect(() =>
      validateAuthConfig({
        ...validConfig,
        refreshToken: { ...validConfig.refreshToken, secret: longRefreshSecret },
      }),
    ).not.toThrow();
  });

  it('still flags short secrets (< 32 chars) containing insecure substrings', () => {
    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: 'password' },
      }),
    ).toThrow('at least 32 characters');
  });

  it('still flags medium-length secrets (< 64 chars) containing insecure substrings', () => {
    // 40 chars: long enough to pass the 32-char minimum, but short enough (< 64) to be checked
    const mediumSecret = 'password-is-here-plus-extra-padding12345';

    expect(mediumSecret.length).toBeGreaterThanOrEqual(32);
    expect(mediumSecret.length).toBeLessThan(64);

    expect(() =>
      validateAuthConfig({
        ...validConfig,
        jwt: { ...validConfig.jwt, secret: mediumSecret },
      }),
    ).toThrow('insecure');
  });
});
