import { Algorithm } from 'jsonwebtoken';

/**
 * Application configuration
 * Loads from environment variables with sensible defaults
 */
export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000'),
    env: process.env.NODE_ENV || 'development',
  },
  server: {
    trustProxy: parseInt(process.env.TRUST_PROXY || '1'),
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
} as const;

export type Config = typeof config;
