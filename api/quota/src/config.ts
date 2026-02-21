/**
 * @module config
 * @description Typed application configuration from environment variables.
 */

export interface QuotaDefaults {
  plugins: number;
  pipelines: number;
  apiCalls: number;
}

export interface AppConfig {
  port: number;
  mongodb: {
    uri: string;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  quota: {
    defaults: QuotaDefaults;
    resetDays: number;
  };
}

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },
  quota: {
    defaults: {
      plugins: parseInt(process.env.QUOTA_DEFAULT_PLUGINS || '100', 10),
      pipelines: parseInt(process.env.QUOTA_DEFAULT_PIPELINES || '10', 10),
      apiCalls: parseInt(process.env.QUOTA_DEFAULT_API_CALLS || '-1', 10),
    },
    resetDays: parseInt(process.env.QUOTA_RESET_DAYS || '3', 10),
  },
};
