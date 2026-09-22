// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, envBool, envInt, serviceEndpoint, type InternalService } from '@pipeline-builder/api-core';
import { CoreConstants } from './app-config.js';
import type { ServerConfig, AuthConfig, RateLimitConfig } from './config-types.js';

const log = createLogger('server-config');

/** `{ <key>Host, <key>Port }` for one sibling service, from the shared registry. */
function endpoint<K extends string>(service: InternalService, key: K): Record<`${K}Host`, string> & Record<`${K}Port`, number> {
  const { host, port } = serviceEndpoint(service);
  return { [`${key}Host`]: host, [`${key}Port`]: port } as Record<`${K}Host`, string> & Record<`${K}Port`, number>;
}

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
    port: envInt('PORT', 3_000),
    cors: {
      credentials: envBool('CORS_CREDENTIALS', true),
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : [process.env.PLATFORM_BASE_URL || CoreConstants.DEFAULT_PLATFORM_URL],
    },
    trustProxy: envInt('TRUST_PROXY', 1),
    platformUrl: process.env.PLATFORM_BASE_URL || CoreConstants.DEFAULT_PLATFORM_URL,

    httpClient: {
      timeout: envInt('HTTP_CLIENT_TIMEOUT', 5_000),
      maxRetries: envInt('HTTP_CLIENT_MAX_RETRIES', 2),
      retryDelayMs: envInt('HTTP_CLIENT_RETRY_DELAY_MS', 200),
    },

    sse: {
      maxClientsPerRequest: envInt('SSE_MAX_CLIENTS_PER_REQUEST', 10),
      clientTimeoutMs: envInt('SSE_CLIENT_TIMEOUT_MS', 1_800_000),
      cleanupIntervalMs: envInt('SSE_CLEANUP_INTERVAL_MS', 300_000),
    },

    services: {
      ...endpoint('plugin', 'plugin'),
      ...endpoint('pipeline', 'pipeline'),
      ...endpoint('message', 'message'),
      ...endpoint('platform', 'platform'),
      ...endpoint('compliance', 'compliance'),
      ...endpoint('billing', 'billing'),
      ...endpoint('image-registry', 'imageRegistry'),
      ...endpoint('quota', 'quota'),
      ...endpoint('reporting', 'reporting'),
      ...endpoint('ask', 'ask'),
      billingTimeout: envInt('BILLING_SERVICE_TIMEOUT', 5000, { min: 1 }),
    },
  };
}

/**
 * Load authentication configuration from environment variables.
 *
 * Environment variables:
 * - `JWT_EXPIRES_IN` — JWT lifetime in seconds (default: `7200` = 2 hours)
 * - `BCRYPT_SALT_ROUNDS` — bcrypt salt rounds for password hashing (default: `12`)
 * - `REFRESH_TOKEN_EXPIRES_IN` — Refresh token lifetime in seconds (default: `2592000` = 30 days)
 *
 * @returns Authentication configuration with safe defaults (empty strings when env vars are unset).
 * Call {@link validateAuthConfig} at server startup to enforce required secrets.
 */
export function loadAuthConfig(): AuthConfig {
  return {
    jwt: {
      expiresIn: envInt('JWT_EXPIRES_IN', 7_200),
      saltRounds: envInt('BCRYPT_SALT_ROUNDS', 12),
    },
    refreshToken: {
      expiresIn: envInt('REFRESH_TOKEN_EXPIRES_IN', 2_592_000),
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
    max: envInt('LIMITER_MAX', 100),
    windowMs: envInt('LIMITER_WINDOWMS', 900_000),
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
  const isWildcard = origin === '*' || (Array.isArray(origin) && origin.includes('*'));
  if (isWildcard) {
    warnings.push('CORS origin set to wildcard (*) - consider restricting to specific domains');
  }
  if (isWildcard && config.cors.credentials) {
    // Browsers reject this combination, but it indicates a misconfiguration
    throw new Error(
      'SECURITY ERROR: CORS_ORIGIN=* with CORS_CREDENTIALS=true is an invalid and insecure configuration. ' +
      'Set CORS_ORIGIN to specific domains or disable CORS_CREDENTIALS.',
    );
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
 * Validate authentication configuration (token lifetimes).
 * Call this at server startup, not during CDK synthesis.
 *
 * No SECRET is validated any more: there is none left. User tokens are ES256
 * signed by platform (whose signing key is validated at platform's boot, where
 * it is loaded) and internal service tokens are ES256 signed per service,
 * whose key and bundle `createApp` requires at startup.
 *
 * @param config - Auth configuration to validate
 * @throws {Error} If token lifetimes are out of range
 */
export function validateAuthConfig(config: AuthConfig): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check JWT expiration times
  if (config.jwt.expiresIn > 86400) {
    errors.push('JWT expiration must not exceed 24 hours (86400 seconds)');
  } else if (config.jwt.expiresIn > 7200) {
    warnings.push('JWT expiration time is greater than 2 hours - shorter expiration recommended');
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
