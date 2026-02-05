import { createLogger } from '@mwashburn160/api-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolConfig, PoolClient } from 'pg';
import { schema } from './drizzle-schema';

const log = createLogger('Database');

/**
 * Get database configuration from environment variables
 */
function getDatabaseConfig() {
  return {
    database: {
      postgres: {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: process.env.POSTGRES_PORT || '5432',
        database: process.env.POSTGRES_DATABASE || 'pipeline',
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || 'postgres',
      },
      drizzle: {
        maxPoolSize: process.env.DRIZZLE_MAX_POOL_SIZE || '20',
        idleTimeoutMillis: process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS || '30000',
        connectionTimeoutMillis: process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS || '2000',
      },
    },
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
  private isShuttingDown = false;
  private connectionAttempts = 0;

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
      maxRetries: options.maxRetries ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      ssl: options.ssl ?? false,
    };

    try {
      const config = getDatabaseConfig();

      const poolConfig: PoolConfig = {
        host: config.database.postgres.host,
        port: parseInt(config.database.postgres.port),
        database: config.database.postgres.database,
        user: config.database.postgres.user,
        password: config.database.postgres.password,
        max: parseInt(config.database.drizzle.maxPoolSize),
        idleTimeoutMillis: parseInt(config.database.drizzle.idleTimeoutMillis),
        connectionTimeoutMillis: parseInt(config.database.drizzle.connectionTimeoutMillis),
        ssl: this.options.ssl,
      };

      this.pool = new Pool(poolConfig);
      this.setupEventHandlers();

      this.db = drizzle(this.pool, { schema });

      if (this.options.enableLogging) {
        log.info('Database connection initialized successfully');
        this.logConnectionConfig(poolConfig);
      }
    } catch (error) {
      log.error('Failed to initialize database connection:', error);
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
      const result = await client.query('SELECT 1');
      client.release();

      if (this.options.enableLogging) {
        log.info('Database connection test successful');
      }

      return result.rows.length > 0;
    } catch (error) {
      log.error('Database connection test failed:', error);
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
   * Executes a database transaction
   *
   * @param callback - Function to execute within the transaction
   * @returns Result of the transaction
   *
   * @example
   * ```typescript
   * const result = await connection.transaction(async (tx) => {
   *   await tx.insert(schema.plugin).values({ ... });
   *   await tx.insert(schema.metadata).values({ ... });
   *   return { success: true };
   * });
   * ```
   */
  public async transaction<T>(
    callback: Parameters<typeof this.db.transaction>[0],
  ): Promise<T> {
    return await this.db.transaction(callback) as T;
  }

  /**
   * Acquires a client from the pool for manual query execution
   * Remember to release the client when done
   *
   * @returns PostgreSQL client from the pool
   *
   * @example
   * ```typescript
   * const client = await connection.getClient();
   * try {
   *   await client.query('BEGIN');
   *   await client.query('INSERT INTO ...');
   *   await client.query('COMMIT');
   * } finally {
   *   client.release();
   * }
   * ```
   */
  public async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Closes the database connection pool gracefully.
   * Should be called during application shutdown.
   *
   * @param timeout - Maximum time to wait for connections to close (ms)
   * @returns Promise that resolves when pool is closed
   */
  public async close(timeout: number = 5000): Promise<void> {
    if (this.isShuttingDown) {
      log.warn('Connection is already shutting down');
      return;
    }

    this.isShuttingDown = true;

    try {
      if (this.options.enableLogging) {
        log.info('Closing database connection pool...');
        const stats = this.getStats();
        log.info(`Pool stats - Total: ${stats.totalCount}, Idle: ${stats.idleCount}, Waiting: ${stats.waitingCount}`);
      }

      // Set a timeout for graceful shutdown
      const closePromise = this.pool.end();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection close timeout')), timeout),
      );

      await Promise.race([closePromise, timeoutPromise]);

      if (this.options.enableLogging) {
        log.info('Database connection closed successfully');
      }
    } catch (error) {
      log.error('Error closing database connection:', error);
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
      log.error('Unexpected error on idle client:', err);

      if (this.options.enableAutoRetry && this.connectionAttempts < this.options.maxRetries) {
        void this.handleConnectionError(err).catch((retryErr) => {
          log.error('Connection retry error:', retryErr);
        });
      }
    });

    this.pool.on('connect', () => {
      this.connectionAttempts = 0; // Reset on successful connection

      if (this.options.enableLogging) {
        log.debug('New database connection established');
      }
    });

    this.pool.on('acquire', () => {
      // Only log at debug level for verbose connection tracking
    });

    this.pool.on('remove', () => {
      if (this.options.enableLogging) {
        log.debug('Client removed from pool');
      }
    });
  }

  /**
   * Handles connection errors with retry logic
   */
  private async handleConnectionError(error: Error): Promise<void> {
    this.connectionAttempts++;

    log.error(
      `Connection error (attempt ${this.connectionAttempts}/${this.options.maxRetries}):`,
      error.message,
    );

    if (this.connectionAttempts < this.options.maxRetries) {
      const delay = this.options.retryDelay * this.connectionAttempts;
      log.info(`Retrying connection in ${delay}ms...`);

      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await this.testConnection();
        log.info('Connection restored');
      } catch (retryError) {
        log.error('Retry failed:', retryError);
      }
    } else {
      log.error('Max connection retry attempts reached');
    }
  }

  /**
   * Logs connection configuration (sanitized)
   */
  private logConnectionConfig(config: PoolConfig): void {
    log.info('Database Configuration:', {
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

/**
 * Initialize the database connection explicitly
 * Call this during application startup after environment is configured
 *
 * @example
 * ```typescript
 * import { initializeDatabase } from './connection';
 *
 * async function bootstrap() {
 *   // Load environment variables first
 *   dotenv.config();
 *
 *   // Then initialize database
 *   await initializeDatabase();
 * }
 * ```
 */
export async function initializeDatabase(): Promise<void> {
  const connection = Connection.getInstance();
  const healthy = await connection.testConnection();
  if (!healthy) {
    throw new Error('Database connection failed during initialization');
  }
}