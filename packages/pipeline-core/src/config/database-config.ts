/**
 * @module config/database-config
 * @description Loads and validates PostgreSQL and Drizzle ORM database configuration from environment variables.
 */

import { createLogger } from '@mwashburn160/api-core';
import type { DatabaseConfig } from './config-types';

const log = createLogger('DatabaseConfig');

/**
 * Load database configuration from environment variables.
 *
 * Environment variables:
 * - `DB_HOST` — PostgreSQL host (default: `'postgres'`)
 * - `DB_PORT` — PostgreSQL port (default: `5432`)
 * - `DATABASE` — PostgreSQL database name (default: `'pipeline_builder'`)
 * - `DB_USER` — PostgreSQL user (default: `'postgres'`)
 * - `DB_PASSWORD` — PostgreSQL password (default: `'password'`)
 * - `DRIZZLE_MAX_POOL_SIZE` — Max connection pool size (default: `20`)
 * - `DRIZZLE_IDLE_TIMEOUT_MILLIS` — Idle connection timeout in ms (default: `30000`)
 * - `DRIZZLE_CONNECTION_TIMEOUT_MILLIS` — New connection timeout in ms (default: `5000`)
 *
 * @returns Fully populated DatabaseConfig with postgres and drizzle sections
 */
export function loadDatabaseConfig(): DatabaseConfig {
  return {
    postgres: {
      host: process.env.DB_HOST || 'postgres',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DATABASE || 'pipeline_builder',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('DB_PASSWORD is required in production'); })() : 'password'),
    },

    drizzle: {
      maxPoolSize: parseInt(process.env.DRIZZLE_MAX_POOL_SIZE || '20', 10),
      idleTimeoutMillis: parseInt(process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS || '5000', 10),
    },
  };
}

/**
 * Validate database configuration and log warnings for suboptimal settings.
 *
 * @param config - Database configuration to validate
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
