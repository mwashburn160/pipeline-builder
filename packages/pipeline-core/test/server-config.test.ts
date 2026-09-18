// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  loadServerConfig,
  loadAuthConfig,
  loadRateLimitConfig,
  validateServerConfig,
  validateAuthConfig,
} = await import('../src/config/server-config.js');

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

  it('reads NO token secret at all — every token is asymmetrically signed', () => {
    // #5 moved user tokens onto platform's ES256 key; #14 moved internal service
    // tokens onto a per-service ES256 key. A leftover env value must not reappear
    // as config, or it would read as a secret an operator still has to rotate.
    process.env.JWT_SECRET = 'a-stale-value-nothing-reads';
    process.env.JWT_ALGORITHM = 'HS384';

    expect(loadAuthConfig().jwt).toEqual({ expiresIn: 7200, saltRounds: 12 });
  });

  it('reads NO refresh-token secret — refresh tokens are signed with platform\'s ES256 key', () => {
    process.env.REFRESH_TOKEN_SECRET = 'a-stale-value-nothing-reads';

    // Only the lifetime remains; a leftover env value must not reappear as
    // config, or it would read as a secret an operator still has to rotate.
    expect(loadAuthConfig().refreshToken).toEqual({ expiresIn: 2592000 });
  });

  it('returns correct values from env', () => {
    process.env.JWT_EXPIRES_IN = '3600';
    process.env.BCRYPT_SALT_ROUNDS = '14';
    process.env.REFRESH_TOKEN_EXPIRES_IN = '86400';

    const config = loadAuthConfig();

    expect(config.jwt.expiresIn).toBe(3600);
    expect(config.jwt.saltRounds).toBe(14);
    expect(config.refreshToken.expiresIn).toBe(86400);
  });

  it('uses defaults when optional env vars are not set', () => {
    delete process.env.JWT_EXPIRES_IN;
    delete process.env.BCRYPT_SALT_ROUNDS;
    delete process.env.REFRESH_TOKEN_EXPIRES_IN;

    const config = loadAuthConfig();

    expect(config.jwt.expiresIn).toBe(7200);
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
  const defaultServices = {
    pluginHost: 'plugin',
    pluginPort: 3000,
    pipelineHost: 'pipeline',
    pipelinePort: 3000,
    messageHost: 'message',
    messagePort: 3000,
    complianceHost: 'compliance',
    compliancePort: 3000,
    billingHost: 'billing',
    billingPort: 3000,
    billingTimeout: 5000,
  };

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
      expiresIn: 3600,
      saltRounds: 12,
    },
    refreshToken: {
      expiresIn: 2592000,
    },
  };

  it('does not throw for valid config', () => {
    expect(() => validateAuthConfig(validConfig)).not.toThrow();
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

  // Fix 25 (secret-strength validation) is GONE with the secret it validated:
  // #5 + #14 left no shared secret to be weak. `validateAuthConfig` now only
  // bounds token lifetimes; key material is validated where it is loaded —
  // platform's signer for user tokens, `createApp` for the per-service keys.
  it('accepts a config with no secret of any kind', () => {
    expect(() => validateAuthConfig(validConfig)).not.toThrow();
    expect(validConfig.jwt).toEqual({ expiresIn: 3600, saltRounds: 12 });
  });
});
