import { createLogger } from '@mwashburn160/api-core';
import type { Algorithm } from 'jsonwebtoken';
import { CoreConstants } from './app-config';
import type { ServerConfig, AuthConfig, RateLimitConfig } from './config-types';

const log = createLogger('ServerConfig');

/**
 * Load server configuration from environment variables.
 *
 * Environment variables:
 * - `PORT` — HTTP listen port (default: `3000`)
 * - `CORS_ORIGIN` — Comma-separated allowed origins (default: `PLATFORM_BASE_URL`)
 * - `CORS_CREDENTIALS` — Allow credentials; set to `'false'` to disable (default: `true`)
 * - `TRUST_PROXY` — Express trust proxy hops (default: `1`)
 * - `PLATFORM_BASE_URL` — Frontend URL used as CORS fallback (default: `'https://localhost:8443'`)
 *
 * @returns Server configuration with port, CORS, trust proxy, and platform URL
 */
export function loadServerConfig(): ServerConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    cors: {
      credentials: process.env.CORS_CREDENTIALS !== 'false',
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : [process.env.PLATFORM_BASE_URL || CoreConstants.DEFAULT_PLATFORM_URL],
    },
    trustProxy: parseInt(process.env.TRUST_PROXY || '1', 10),
    platformUrl: process.env.PLATFORM_BASE_URL || CoreConstants.DEFAULT_PLATFORM_URL,

    httpClient: {
      timeout: parseInt(process.env.HTTP_CLIENT_TIMEOUT || '5000', 10),
      maxRetries: parseInt(process.env.HTTP_CLIENT_MAX_RETRIES || '2', 10),
      retryDelayMs: parseInt(process.env.HTTP_CLIENT_RETRY_DELAY_MS || '200', 10),
    },

    sse: {
      maxClientsPerRequest: parseInt(process.env.SSE_MAX_CLIENTS_PER_REQUEST || '10', 10),
      clientTimeoutMs: parseInt(process.env.SSE_CLIENT_TIMEOUT_MS || '1800000', 10),
      cleanupIntervalMs: parseInt(process.env.SSE_CLEANUP_INTERVAL_MS || '300000', 10),
    },

    services: {
      pluginHost: process.env.PLUGIN_SERVICE_HOST || 'plugin',
      pluginPort: parseInt(process.env.PLUGIN_SERVICE_PORT || '3000', 10),
    },
  };
}

/**
 * Load authentication configuration from environment variables.
 *
 * Environment variables:
 * - `JWT_SECRET` — **Required.** Secret key for signing JWTs
 * - `REFRESH_TOKEN_SECRET` — **Required.** Secret key for signing refresh tokens
 * - `JWT_EXPIRES_IN` — JWT lifetime in seconds (default: `7200` = 2 hours)
 * - `JWT_ALGORITHM` — JWT signing algorithm (default: `'HS256'`)
 * - `JWT_SALT_ROUNDS` — bcrypt salt rounds for password hashing (default: `12`)
 * - `REFRESH_TOKEN_EXPIRES_IN` — Refresh token lifetime in seconds (default: `2592000` = 30 days)
 *
 * @returns Authentication configuration with safe defaults (empty strings when env vars are unset).
 * Call {@link validateAuthConfig} at server startup to enforce required secrets.
 */
export function loadAuthConfig(): AuthConfig {
  return {
    jwt: {
      secret: process.env.JWT_SECRET || '',
      expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '7200', 10),
      algorithm: (process.env.JWT_ALGORITHM || 'HS256') as Algorithm,
      saltRounds: parseInt(process.env.JWT_SALT_ROUNDS || '12', 10),
    },
    refreshToken: {
      secret: process.env.REFRESH_TOKEN_SECRET || '',
      expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000', 10),
    },
  };
}

/**
 * Load rate limiting configuration from environment variables.
 *
 * Environment variables:
 * - `LIMITER_MAX` — Max requests per window (default: `100`)
 * - `LIMITER_WINDOWMS` — Rate limit window in ms (default: `900000` = 15 minutes)
 *
 * @returns Rate limit configuration
 */
export function loadRateLimitConfig(): RateLimitConfig {
  return {
    max: parseInt(process.env.LIMITER_MAX || '100', 10),
    windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000', 10),
    legacyHeaders: false,
    standardHeaders: true,
  };
}

/**
 * Validate server configuration and log warnings for insecure settings.
 *
 * @param config - Server configuration to validate
 */
export function validateServerConfig(config: ServerConfig): void {
  const warnings: string[] = [];

  // Check CORS configuration
  const origin = config.cors.origin;
  if (origin === '*' || (Array.isArray(origin) && origin.includes('*'))) {
    warnings.push('CORS origin set to wildcard (*) - consider restricting to specific domains');
  }

  // Check platform URL uses HTTPS
  if (config.platformUrl.startsWith('http://') &&
    !config.platformUrl.includes('localhost')) {
    warnings.push('Platform URL uses HTTP instead of HTTPS - insecure for production');
  }

  // Display warnings
  if (warnings.length > 0) {
    log.warn('Server configuration warnings:');
    warnings.forEach(warning => log.warn(`  - ${warning}`));
  }
}

/**
 * Validate authentication configuration (JWT secrets, algorithms, expiration).
 * Call this at server startup, not during CDK synthesis.
 *
 * @param config - Auth configuration to validate
 * @throws {Error} If secrets are insecure, too short (<32 chars), or use disallowed algorithms
 */
const INSECURE_PATTERNS = ['secret', 'password', 'changeme', 'default', '123456', 'admin'];

function isInsecureSecret(secret: string): boolean {
  const lower = secret.toLowerCase();
  return INSECURE_PATTERNS.some(s => lower === s || (secret.length < 64 && lower.includes(s)));
}

export function validateAuthConfig(config: AuthConfig): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate both secrets with the same checks
  for (const [label, secret] of [['JWT', config.jwt.secret], ['Refresh token', config.refreshToken.secret]] as const) {
    if (secret.length < 32) {
      errors.push(`${label} secret should be at least 32 characters long`);
    }
    if (isInsecureSecret(secret)) {
      errors.push(`${label} secret appears to be insecure or default value`);
    }
  }

  // Check JWT expiration times
  if (config.jwt.expiresIn > 86400) {
    errors.push('JWT expiration must not exceed 24 hours (86400 seconds)');
  } else if (config.jwt.expiresIn > 7200) {
    warnings.push('JWT expiration time is greater than 2 hours - shorter expiration recommended');
  }

  // Check algorithm
  if (!CoreConstants.ALLOWED_JWT_ALGORITHMS.includes(config.jwt.algorithm)) {
    errors.push(`JWT algorithm ${config.jwt.algorithm} is not in the allowed list`);
  }

  // Display warnings
  if (warnings.length > 0) {
    log.warn('Auth configuration warnings:');
    warnings.forEach(warning => log.warn(`  - ${warning}`));
  }

  // Throw errors
  if (errors.length > 0) {
    throw new Error(
      `Auth configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
    );
  }
}
