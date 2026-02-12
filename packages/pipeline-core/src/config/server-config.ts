import { createLogger } from '@mwashburn160/api-core';
import { Algorithm } from 'jsonwebtoken';
import { CoreConstants } from './app-config';
import { ServerConfig, AuthConfig, RateLimitConfig } from './config-types';

const log = createLogger('ServerConfig');

/**
 * Load server configuration from environment variables
 */
export function loadServerConfig(): ServerConfig {
  return {
    port: parseInt(process.env.PORT || '3000'),
    cors: {
      credentials: process.env.CORS_CREDENTIALS !== 'false',
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
        : [process.env.PLATFORM_BASE_URL || 'https://localhost:8443'],
    },
    trustProxy: parseInt(process.env.TRUST_PROXY || '1'),
    platformUrl: process.env.PLATFORM_BASE_URL || 'https://localhost:8443',
  };
}

/**
 * Load authentication configuration from environment variables
 */
export function loadAuthConfig(): AuthConfig {
  return {
    jwt: {
      secret: process.env.JWT_SECRET || 'no-secret',
      expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '7200'),
      algorithm: (process.env.JWT_ALGORITHM || 'HS256') as Algorithm,
      saltRounds: parseInt(process.env.JWT_SALT_ROUNDS || '12'),
    },
    refreshToken: {
      secret: process.env.REFRESH_TOKEN_SECRET || 'no-secret',
      expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000'),
    },
  };
}

/**
 * Load rate limiting configuration from environment variables
 */
export function loadRateLimitConfig(): RateLimitConfig {
  return {
    max: parseInt(process.env.LIMITER_MAX || '100'),
    windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000'),
    legacyHeaders: false,
    standardHeaders: true,
  };
}

/**
 * Validate server configuration
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
 * Validate authentication configuration (JWT secrets, algorithms, expiration)
 * Call this at server startup, not during CDK synthesis.
 */
export function validateAuthConfig(config: AuthConfig): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for insecure secrets
  const insecureSecrets = [
    'secret',
    'password',
    'changeme',
    'default',
    '123456',
    'admin',
  ];

  const jwtSecretLower = config.jwt.secret.toLowerCase();
  if (insecureSecrets.some(s => jwtSecretLower.includes(s))) {
    errors.push('JWT secret appears to be insecure or default value');
  }

  const refreshSecretLower = config.refreshToken.secret.toLowerCase();
  if (insecureSecrets.some(s => refreshSecretLower.includes(s))) {
    errors.push('Refresh token secret appears to be insecure or default value');
  }

  // Check secret length
  if (config.jwt.secret.length < 32) {
    errors.push('JWT secret should be at least 32 characters long');
  }

  if (config.refreshToken.secret.length < 32) {
    errors.push('Refresh token secret should be at least 32 characters long');
  }

  // Check JWT expiration times
  if (config.jwt.expiresIn > 7200) {
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
