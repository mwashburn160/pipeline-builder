import { createLogger } from '@mwashburn160/api-core';
import { DatabaseConfig } from './config-types';

const log = createLogger('DatabaseConfig');

/**
 * Load database configuration from environment variables
 */
export function loadDatabaseConfig(): DatabaseConfig {
  return {
    postgres: {
      host: process.env.DB_HOST || 'postgres',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DATABASE || 'pipeline_builder',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password',
    },
    mongodb: {
      uri: process.env.MONGODB_URI || 'mongodb://mongo:password@mongodb:27017/platform?replicaSet=rs0&authSource=admin',
    },
    drizzle: {
      maxPoolSize: parseInt(process.env.DRIZZLE_MAX_POOL_SIZE || '20'),
      idleTimeoutMillis: parseInt(process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS || '5000'),
    },
  };
}

/**
 * Validate database configuration
 */
export function validateDatabaseConfig(config: DatabaseConfig): void {
  const warnings: string[] = [];

  // Check pool size
  if (config.drizzle.maxPoolSize < 10) {
    warnings.push('Database pool size is less than 10 - may cause performance issues under load');
  }

  // Display warnings
  if (warnings.length > 0) {
    log.warn('Database configuration warnings:');
    warnings.forEach(warning => log.warn(`  - ${warning}`));
  }
}
