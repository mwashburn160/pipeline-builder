import { Algorithm } from 'jsonwebtoken';

/**
 * Parse quota limit from environment variable
 * Supports 'unlimited' string or numeric values
 */
function parseQuotaLimit(value: string | undefined, defaultValue: number | 'unlimited'): number | 'unlimited' {
  if (!value) return defaultValue;
  if (value === 'unlimited') return 'unlimited';
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Application configuration
 * Loads from environment variables with sensible defaults
 */
export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000'),
    baseUrl: process.env.PLATFORM_BASE_URL || 'https://localhost:8443',
    frontendUrl: process.env.PLATFORM_FRONTEND_URL || 'https://localhost:8443',
  },
  server: {
    trustProxy: parseInt(process.env.TRUST_PROXY || '1'),
  },
  logger: {
    level: process.env.LOG_LEVEL || 'debug',
  },
  cors: {
    credentials: process.env.CORS_CREDENTIALS !== 'false',
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : '*',
  },
  rateLimit: {
    max: parseInt(process.env.LIMITER_MAX || '100'),
    windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000'),
  },
  auth: {
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
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://mongo:password@mongodb:27017/platform?replicaSet=rs0&authSource=admin',
  },
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Platform',
    provider: 'smtp',
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },
  invitation: {
    expirationDays: parseInt(process.env.INVITATION_EXPIRATION_DAYS || '7'),
    maxPendingPerOrg: parseInt(process.env.INVITATION_MAX_PENDING_PER_ORG || '50'),
  },
  services: {
    listPlugins: process.env.LIST_PLUGINS_URL || 'https://localhost:8443',
    getPlugin: process.env.GET_PLUGIN_URL || 'https://localhost:8443',
    uploadPlugin: process.env.UPLOAD_PLUGIN_URL || 'https://localhost:8443',
    listPipelines: process.env.LIST_PIPELINES_URL || 'https://localhost:8443',
    getPipeline: process.env.GET_PIPELINE_URL || 'https://localhost:8443',
    createPipeline: process.env.CREATE_PIPELINE_URL || 'https://localhost:8443',
    timeout: parseInt(process.env.SERVICE_TIMEOUT || '30000'),
  },
  quota: {
    // Organization ID that bypasses all quotas
    bypassOrgId: process.env.QUOTA_BYPASS_ORG_ID || 'system',
    // Default window in milliseconds (60 seconds)
    defaultWindowMs: parseInt(process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
    // Pipeline quotas
    pipeline: {
      create: {
        limit: parseQuotaLimit(process.env.QUOTA_CREATE_PIPELINE_LIMIT, 'unlimited'),
        windowMs: parseInt(process.env.QUOTA_CREATE_PIPELINE_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
      },
      get: {
        limit: parseQuotaLimit(process.env.QUOTA_GET_PIPELINE_LIMIT, 10),
        windowMs: parseInt(process.env.QUOTA_GET_PIPELINE_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
      },
      list: {
        limit: parseQuotaLimit(process.env.QUOTA_LIST_PIPELINES_LIMIT, 10),
        windowMs: parseInt(process.env.QUOTA_LIST_PIPELINES_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
      },
    },
    // Plugin quotas
    plugin: {
      create: {
        limit: parseQuotaLimit(process.env.QUOTA_CREATE_PLUGIN_LIMIT, 'unlimited'),
        windowMs: parseInt(process.env.QUOTA_CREATE_PLUGIN_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
      },
      get: {
        limit: parseQuotaLimit(process.env.QUOTA_GET_PLUGIN_LIMIT, 10),
        windowMs: parseInt(process.env.QUOTA_GET_PLUGIN_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
      },
      list: {
        limit: parseQuotaLimit(process.env.QUOTA_LIST_PLUGINS_LIMIT, 10),
        windowMs: parseInt(process.env.QUOTA_LIST_PLUGINS_WINDOW_MS || process.env.QUOTA_DEFAULT_WINDOW_MS || '60000'),
      },
    },
  },
} as const;

export type Config = typeof config;
