// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { schema } from './drizzle-schema.js';
import { ConnectionRetryStrategy } from './retry-strategy.js';

const logger = createLogger('database');

/**
 * Get database configuration from environment variables
 * Note: Uses environment variables directly to avoid circular dependency with pipeline-core
 */
function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Detect Lambda environment for pool-size tuning */
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

/**
 * Resolve the pg TLS/SSL config from an explicit option or the environment,
 * following the same env-tunable pattern as the pool sizing above.
 *
 * Precedence:
 *   1. An explicit `options.ssl` (constructor arg) always wins — including an
 *      explicit `false` to force plaintext.
 *   2. `DB_SSL` (`true`/`1` on, `false`/`0` off) or Postgres' standard
 *      `PGSSLMODE` (`disable` = off, any other mode = on).
 *   3. Default: ON in production (RDS connections must be encrypted in transit),
 *      OFF everywhere else so a local Postgres without TLS keeps working.
 *
 * When enabled, `rejectUnauthorized` follows `DB_SSL_REJECT_UNAUTHORIZED`
 * (default `false`): AWS RDS presents a cert signed by the RDS CA, which is not
 * in Node's default trust store unless the CA bundle is mounted, so certificate
 * VERIFICATION is opt-in to avoid breaking a stock RDS deploy — the channel is
 * still ENCRYPTED. Set `DB_SSL_REJECT_UNAUTHORIZED=true` once the RDS CA bundle
 * is wired to get full verification.
 */
export function getSslConfig(explicit?: ConnectionOptions['ssl']): boolean | { rejectUnauthorized: boolean } {
  if (explicit !== undefined) return explicit;

  const dbSsl = process.env.DB_SSL?.toLowerCase();
  const sslMode = process.env.PGSSLMODE?.toLowerCase();

  let enabled: boolean;
  if (dbSsl === 'true' || dbSsl === '1') enabled = true;
  else if (dbSsl === 'false' || dbSsl === '0') enabled = false;
  else if (sslMode) enabled = sslMode !== 'disable';
  else enabled = process.env.NODE_ENV === 'production';

  if (!enabled) return false;
  return { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' };
}

function getDatabaseConfig() {
  // Lambda: small pool (each invocation is short-lived, many concurrent instances)
  // ECS/long-running: larger pool for sustained concurrency
  const defaultPoolSize = isLambda ? 2 : 20;
  const defaultIdleTimeout = isLambda ? 10000 : 30000;

  return {
    host: process.env.DB_HOST || 'postgres',
    port: parseIntEnv(process.env.DB_PORT, 5432),
    database: process.env.DATABASE || 'pipeline_builder',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('DB_PASSWORD is required in production'); })() as string : ''),
    maxPoolSize: parseIntEnv(process.env.DRIZZLE_MAX_POOL_SIZE, defaultPoolSize),
    idleTimeoutMillis: parseIntEnv(process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS, defaultIdleTimeout),
    connectionTimeoutMillis: parseIntEnv(process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS, 5000),
  };
}

/**
 * Database connection statistics for monitoring
 */
export interface ConnectionStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/**
 * Options for configuring the database connection
 */
export interface ConnectionOptions {
  /** Whether to enable connection logging */
  enableLogging?: boolean;

  /** Whether to automatically retry failed connections */
  enableAutoRetry?: boolean;

  /** Maximum number of connection retry attempts */
  maxRetries?: number;

  /** Delay between retry attempts in milliseconds */
  retryDelay?: number;

  /** SSL configuration */
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Singleton database connection class.
 * Manages PostgreSQL connection pooling and Drizzle ORM instance.
 *
 * Features:
 * - Singleton pattern for single connection pool
 * - Automatic connection retry with backoff
 * - Connection health monitoring
 * - Graceful shutdown handling
 * - Comprehensive error handling
 * - Connection statistics tracking
 *
 * @example
 * ```typescript
 * import { Connection } from './connection';
 *
 * const connection = Connection.getInstance();
 * const plugins = await connection.db.select().from(schema.plugin);
 *
 * // During shutdown
 * await connection.close();
 * ```
 */
export class Connection {
  private static instance: Connection | null = null;

  /**
   * Drizzle ORM database instance with schema
   */
  public readonly db: ReturnType<typeof drizzle>;

  private readonly pool: Pool;
  private readonly options: Required<ConnectionOptions>;
  private readonly retryStrategy: ConnectionRetryStrategy;
  private isShuttingDown = false;

  /**
   * Private constructor to enforce singleton pattern.
   * Initializes PostgreSQL connection pool and Drizzle ORM instance.
   *
   * @param options - Optional configuration for the connection
   * @throws {Error} If database initialization fails after all retries
   */
  private constructor(options: ConnectionOptions = {}) {
    this.options = {
      enableLogging: options.enableLogging ?? true,
      enableAutoRetry: options.enableAutoRetry ?? true,
      maxRetries: options.maxRetries ?? parseInt(process.env.DB_MAX_RETRIES || '3', 10),
      retryDelay: options.retryDelay ?? parseInt(process.env.DB_RETRY_DELAY_MS || '1000', 10),
      // Env-driven TLS: on-by-default in production, env-enableable elsewhere.
      // getInstance() is normally called with no options, so this is the only
      // place production RDS connections pick up SSL (formerly hard-coded off).
      ssl: getSslConfig(options.ssl),
    };

    // Initialize retry strategy
    this.retryStrategy = new ConnectionRetryStrategy({
      maxRetries: this.options.maxRetries,
      baseDelay: this.options.retryDelay,
    });

    try {
      const config = getDatabaseConfig();

      const poolConfig: PoolConfig = {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        max: config.maxPoolSize,
        idleTimeoutMillis: config.idleTimeoutMillis,
        connectionTimeoutMillis: config.connectionTimeoutMillis,
        ssl: this.options.ssl,
        allowExitOnIdle: true,
      };

      this.pool = new Pool(poolConfig);
      this.setupEventHandlers();

      this.db = drizzle(this.pool, { schema });

      if (this.options.enableLogging) {
        logger.info('Database connection initialized successfully');
        this.logConnectionConfig(poolConfig);
      }
    } catch (error) {
      logger.error('Failed to initialize database connection:', error);
      throw new Error('Database initialization failed');
    }
  }

  /**
   * Gets the singleton instance of the Connection class.
   * Creates a new instance if one doesn't exist.
   *
   * @param options - Optional configuration (only used on first call)
   * @returns The singleton Connection instance
   */
  public static getInstance(options?: ConnectionOptions): Connection {
    if (!Connection.instance) {
      Connection.instance = new Connection(options);
    }
    return Connection.instance;
  }

  /**
   * Resets the singleton instance.
   * Useful for testing or reconfiguring the connection.
   *
   * @param closeExisting - Whether to close existing connection before reset
   */
  public static async reset(closeExisting: boolean = true): Promise<void> {
    if (Connection.instance && closeExisting) {
      await Connection.instance.close();
    }
    Connection.instance = null;
  }

  /**
   * Tests the database connection
   *
   * @returns Promise that resolves to true if connection is healthy
   */
  public async testConnection(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      // Release even if the probe query throws — otherwise a flaky DB (the exact
      // case this check exists for) leaks a pooled client each failure and can
      // exhaust the pool on the retry path.
      try {
        const result = await client.query('SELECT 1');
        if (this.options.enableLogging) {
          logger.info('Database connection test successful');
        }
        return result.rows.length > 0;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Database connection test failed:', error);
      return false;
    }
  }

  /**
   * Gets connection pool statistics
   *
   * @returns Current connection pool statistics
   */
  public getStats(): ConnectionStats {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Closes the database connection pool gracefully.
   * Should be called during application shutdown.
   *
   * @param timeout - Maximum time to wait for connections to close (ms)
   * @returns Promise that resolves when pool is closed
   */
  public async close(timeout: number = parseIntEnv(process.env.DB_CLOSE_TIMEOUT_MS, 5000)): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Connection is already shutting down');
      return;
    }

    this.isShuttingDown = true;

    try {
      if (this.options.enableLogging) {
        logger.info('Closing database connection pool...');
        const stats = this.getStats();
        logger.info(`Pool stats - Total: ${stats.totalCount}, Idle: ${stats.idleCount}, Waiting: ${stats.waitingCount}`);
      }

      // Set a timeout for graceful shutdown
      const closePromise = this.pool.end();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection close timeout')), timeout),
      );

      await Promise.race([closePromise, timeoutPromise]);

      if (this.options.enableLogging) {
        logger.info('Database connection closed successfully');
      }
    } catch (error) {
      logger.error('Error closing database connection:', error);
      throw error;
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * Checks if the connection is shutting down
   *
   * @returns true if connection is in shutdown state
   */
  public isClosing(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Sets up event handlers for the connection pool
   */
  private setupEventHandlers(): void {
    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client:', err);

      if (this.options.enableAutoRetry && this.retryStrategy.getAttempts() < this.options.maxRetries) {
        void this.retryStrategy.handleConnectionError(err, () => this.testConnection()).catch((retryErr) => {
          logger.error('Connection retry error:', retryErr);
        });
      }
    });

    this.pool.on('connect', () => {
      this.retryStrategy.reset(); // Reset on successful connection

      if (this.options.enableLogging) {
        logger.debug('New database connection established');
      }
    });

    this.pool.on('remove', () => {
      if (this.options.enableLogging) {
        logger.debug('Client removed from pool');
      }
    });
  }

  /**
   * Logs connection configuration (sanitized)
   */
  private logConnectionConfig(config: PoolConfig): void {
    logger.info('Database Configuration:', {
      host: `${config.host}:${config.port}`,
      database: config.database,
      user: config.user,
      maxPoolSize: config.max,
      idleTimeoutMs: config.idleTimeoutMillis,
      connectionTimeoutMs: config.connectionTimeoutMillis,
      ssl: config.ssl ? 'enabled' : 'disabled',
    });
  }
}

/**
 * Singleton database instance for use throughout the application.
 *
 * @example
 * ```typescript
 * import { db } from './connection';
 *
 * // Select queries
 * const plugins = await db.select().from(schema.plugin);
 *
 * // Insert queries
 * await db.insert(schema.plugin).values({ name: 'my-plugin' });
 *
 * // Transactions
 * await db.transaction(async (tx) => {
 *   await tx.insert(schema.plugin).values({ ... });
 *   await tx.update(schema.plugin).set({ ... });
 * });
 * ```
 */

// Lazy initialization to avoid race condition on module load
let _dbInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Get the database instance with lazy initialization
 * This avoids the race condition where the module is loaded before environment is configured
 */
function getDbInstance(): ReturnType<typeof drizzle> {
  if (!_dbInstance) {
    _dbInstance = Connection.getInstance().db;
  }
  return _dbInstance;
}

/**
 * Proxy-based lazy database instance
 * The actual connection is only created when first accessed
 *
 * @example
 * ```typescript
 * import { db } from './connection';
 *
 * // Connection is created here on first use, not on import
 * const plugins = await db.select().from(schema.plugin);
 * ```
 */
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_, prop: string | symbol) {
    const instance = getDbInstance();
    const value = instance[prop as keyof typeof instance];
    // Bind methods to the instance to preserve 'this' context
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
});

/**
 * Gets the Connection instance for advanced operations
 *
 * @example
 * ```typescript
 * import { getConnection } from './connection';
 *
 * const connection = getConnection();
 * const stats = connection.getStats();
 * console.log(`Active connections: ${stats.totalCount}`);
 * ```
 */
export function getConnection(): Connection {
  return Connection.getInstance();
}

/**
 * Closes the database connection
 * Should be called during application shutdown
 *
 * @example
 * ```typescript
 * import { closeConnection } from './connection';
 *
 * process.on('SIGTERM', async () => {
 *   await closeConnection();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeConnection(): Promise<void> {
  const connection = Connection.getInstance();
  await connection.close();
  _dbInstance = null; // Reset lazy instance
}

/**
 * Tests the database connection
 *
 * @returns Promise that resolves to true if connection is healthy
 *
 * @example
 * ```typescript
 * import { testConnection } from './connection';
 *
 * if (await testConnection()) {
 *   console.log('Database is ready');
 * } else {
 *   console.error('Database connection failed');
 *   process.exit(1);
 * }
 * ```
 */
export async function testConnection(): Promise<boolean> {
  const connection = Connection.getInstance();
  return connection.testConnection();
}
