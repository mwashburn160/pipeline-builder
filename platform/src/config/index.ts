import { Algorithm } from 'jsonwebtoken';

/**
 * Application configuration
 * Loads from environment variables with sensible defaults
 */
export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000'),
    baseUrl: process.env.PLATFORM_URL || 'https://localhost:8443',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4200',
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
    provider: process.env.EMAIL_PROVIDER || 'smtp', // 'smtp' | 'sendgrid' | 'ses'
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Platform',
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    sendgrid: {
      apiKey: process.env.SENDGRID_API_KEY || '',
    },
    ses: {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
  },
  invitation: {
    expirationDays: parseInt(process.env.INVITATION_EXPIRATION_DAYS || '7'),
    maxPendingPerOrg: parseInt(process.env.INVITATION_MAX_PENDING_PER_ORG || '50'),
  },
  services: {
    listPlugins: process.env.LIST_PLUGINS_URL || 'http://localhost:3001',
    getPlugin: process.env.GET_PLUGIN_URL || 'http://localhost:3002',
    uploadPlugin: process.env.UPLOAD_PLUGIN_URL || 'http://localhost:3003',
    listPipelines: process.env.LIST_PIPELINES_URL || 'http://localhost:3004',
    getPipeline: process.env.GET_PIPELINE_URL || 'http://localhost:3005',
    createPipeline: process.env.CREATE_PIPELINE_URL || 'http://localhost:3006',
    timeout: parseInt(process.env.SERVICE_TIMEOUT || '30000'),
  },
} as const;

export type Config = typeof config;
