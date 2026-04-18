// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { QUOTA_TIERS } from '@mwashburn160/api-core';
import { Algorithm } from 'jsonwebtoken';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/** Default platform URL used as fallback for PLATFORM_BASE_URL, CORS, OAuth callbacks, and service URLs. */
const DEFAULT_PLATFORM_URL = 'https://localhost:8443';

/**
 * Require an environment variable in production, allow a dev-only fallback.
 * @internal
 */
function requireSecret(envVar: string, name: string): string {
  const value = process.env[envVar];
  if (value) return value;
  if (isDev) return 'dev-only-insecure-secret';
  throw new Error(`${name} (${envVar}) is required in production. Generate with: openssl rand -base64 32`);
}

/**
 * Parse quota limit from environment variable.
 * Supports 'unlimited' string or numeric values.
 *
 * @param value - Environment variable value
 * @param defaultValue - Default if not set or invalid
 * @returns Parsed limit or 'unlimited'
 * @internal
 */
function parseQuotaLimit(value: string | undefined, defaultValue: number | 'unlimited'): number | 'unlimited' {
  if (!value) return defaultValue;
  if (value === 'unlimited') return 'unlimited';
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Application configuration object.
 * All values are loaded from environment variables with defaults.
 */
export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    baseUrl: process.env.PLATFORM_BASE_URL || DEFAULT_PLATFORM_URL,
    frontendUrl: process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
  },

  server: {
    trustProxy: parseInt(process.env.TRUST_PROXY || '1', 10),
  },

  logger: {
    level: process.env.LOG_LEVEL || 'debug',
  },

  cors: {
    credentials: process.env.CORS_CREDENTIALS !== 'false',
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : [process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL],
  },

  rateLimit: {
    max: parseInt(process.env.LIMITER_MAX || '100', 10),
    windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000', 10), // 15 min
    auth: {
      max: parseInt(process.env.AUTH_LIMITER_MAX || '20', 10),
      windowMs: parseInt(process.env.AUTH_LIMITER_WINDOWMS || '900000', 10), // 15 min
    },
  },
  auth: {
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),
    jwt: {
      secret: requireSecret('JWT_SECRET', 'JWT secret'),
      expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '7200', 10), // 2 hr
      algorithm: (process.env.JWT_ALGORITHM || 'HS256') as Algorithm,
      saltRounds: parseInt(process.env.JWT_SALT_ROUNDS || '12', 10),
    },
    refreshToken: {
      secret: requireSecret('REFRESH_TOKEN_SECRET', 'Refresh token secret'),
      expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000', 10), // 30 days
    },
    cookie: {
      sameSite: (process.env.COOKIE_SAME_SITE || 'lax') as 'lax' | 'strict' | 'none',
    },
  },

  mongodb: {
    // MONGODB_URI must be set via environment; no credentials in source code.
    // Example: mongodb://mongo:<password>@mongodb:27017/platform?replicaSet=rs0&authSource=admin
    uri: (() => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI environment variable is required');
      return uri;
    })(),
  },

  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Platform',
    provider: (process.env.EMAIL_PROVIDER || 'smtp') as 'smtp' | 'ses',
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    ses: {
      region: process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.SES_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.SES_SECRET_ACCESS_KEY || '',
    },
  },

  invitation: {
    expirationDays: parseInt(process.env.INVITATION_EXPIRATION_DAYS || '7', 10),
    maxPendingPerOrg: parseInt(process.env.INVITATION_MAX_PENDING_PER_ORG || '50', 10),
  },

  oauth: {
    /** Base URL for OAuth callback redirects (e.g. https://yourdomain.com) */
    callbackBaseUrl: process.env.OAUTH_CALLBACK_BASE_URL || process.env.PLATFORM_FRONTEND_URL || DEFAULT_PLATFORM_URL,
    stateTtlMs: parseInt(process.env.OAUTH_STATE_TTL_MS || '600000', 10), // 10 min
    cleanupIntervalMs: parseInt(process.env.OAUTH_CLEANUP_INTERVAL_MS || '60000', 10), // 1 min
    google: {
      clientId: process.env.OAUTH_GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_GOOGLE_CLIENT_ID,
      authorizeUrl: process.env.GOOGLE_AUTHORIZE_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      userinfoUrl: process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v2/userinfo',
    },
    github: {
      clientId: process.env.OAUTH_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET || '',
      enabled: !!process.env.OAUTH_GITHUB_CLIENT_ID,
      authorizeUrl: process.env.GITHUB_AUTHORIZE_URL || 'https://github.com/login/oauth/authorize',
      tokenUrl: process.env.GITHUB_TOKEN_URL || 'https://github.com/login/oauth/access_token',
      userinfoUrl: process.env.GITHUB_USERINFO_URL || 'https://api.github.com/user',
    },
  },

  services: {
    listPlugins: process.env.LIST_PLUGINS_URL || DEFAULT_PLATFORM_URL,
    getPlugin: process.env.GET_PLUGIN_URL || DEFAULT_PLATFORM_URL,
    uploadPlugin: process.env.UPLOAD_PLUGIN_URL || DEFAULT_PLATFORM_URL,
    listPipelines: process.env.LIST_PIPELINES_URL || DEFAULT_PLATFORM_URL,
    getPipeline: process.env.GET_PIPELINE_URL || DEFAULT_PLATFORM_URL,
    createPipeline: process.env.CREATE_PIPELINE_URL || DEFAULT_PLATFORM_URL,
    timeout: parseInt(process.env.SERVICE_TIMEOUT || '30000', 10), // 30s
  },

  quota: {
    // Quota microservice connection
    serviceHost: process.env.QUOTA_SERVICE_HOST || 'quota',
    servicePort: parseInt(process.env.QUOTA_SERVICE_PORT || '3000', 10),
    serviceTimeout: parseInt(process.env.QUOTA_SERVICE_TIMEOUT || '5000', 10), // 5s
    // Organization ID that bypasses all quotas
    bypassOrgId: process.env.QUOTA_BYPASS_ORG_ID || 'system',
    // Default window in milliseconds (60 seconds)
    defaultWindowMs: parseInt(process.env.QUOTA_DEFAULT_WINDOW_MS || '60000', 10), // 1 min
    // Quota tier presets (each tier defines its own limits and reset periods)
    tier: {
      developer: {
        ...QUOTA_TIERS.developer.limits,
        resetPeriod: { plugins: '3days', pipelines: '3days', apiCalls: '3days' },
      },
      pro: {
        ...QUOTA_TIERS.pro.limits,
        resetPeriod: { plugins: '3days', pipelines: '3days', apiCalls: '3days' },
      },
      unlimited: {
        ...QUOTA_TIERS.unlimited.limits,
        resetPeriod: { plugins: '30days', pipelines: '30days', apiCalls: '30days' },
      },
    },
    // Pipeline quotas
    pipeline: {
      create: {
        limit: parseQuotaLimit(process.env.QUOTA_CREATE_PIPELINE_LIMIT, 'unlimited'),
        windowMs: parseInt(process.env.QUOTA_CREATE_PIPELINE_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000', 10),
      },
      get: {
        limit: parseQuotaLimit(process.env.QUOTA_GET_PIPELINE_LIMIT, 10),
        windowMs: parseInt(process.env.QUOTA_GET_PIPELINE_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000', 10),
      },
    },
    // Plugin quotas
    plugin: {
      create: {
        limit: parseQuotaLimit(process.env.QUOTA_CREATE_PLUGIN_LIMIT, 'unlimited'),
        windowMs: parseInt(process.env.QUOTA_CREATE_PLUGIN_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000', 10),
      },
      get: {
        limit: parseQuotaLimit(process.env.QUOTA_GET_PLUGIN_LIMIT, 10),
        windowMs: parseInt(process.env.QUOTA_GET_PLUGIN_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000', 10),
      },
    },
  },

  billing: {
    enabled: (process.env.BILLING_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.BILLING_SERVICE_HOST || 'billing',
    servicePort: parseInt(process.env.BILLING_SERVICE_PORT || '3000', 10),
    serviceTimeout: parseInt(process.env.BILLING_SERVICE_TIMEOUT || '5000', 10), // 5s
  },

  compliance: {
    enabled: (process.env.COMPLIANCE_ENABLED || 'true').toLowerCase() !== 'false',
    serviceHost: process.env.COMPLIANCE_SERVICE_HOST || 'compliance',
    servicePort: parseInt(process.env.COMPLIANCE_SERVICE_PORT || '3000', 10),
    serviceTimeout: parseInt(process.env.COMPLIANCE_SERVICE_TIMEOUT || '5000', 10), // 5s
  },

  loki: {
    url: process.env.LOKI_URL || 'http://loki:3100',
    timeout: parseInt(process.env.LOKI_TIMEOUT || '10000', 10), // 10s
  },

  logs: {
    defaultLimit: parseInt(process.env.LOG_DEFAULT_LIMIT || '100', 10),
    maxLimit: parseInt(process.env.LOG_MAX_LIMIT || '1000', 10),
    defaultLookbackMs: parseInt(process.env.LOG_DEFAULT_LOOKBACK_MS || '3600000', 10), // 1 hr
  },

  pagination: {
    defaultLimit: parseInt(process.env.PLATFORM_LIST_DEFAULT || '20', 10),
    maxLimit: parseInt(process.env.PLATFORM_LIST_MAX || '100', 10),
  },
} as const;

export type Config = typeof config;
