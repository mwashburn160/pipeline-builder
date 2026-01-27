import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolConfig, PoolClient } from 'pg';
import { schema } from './schema';
import { Config } from '../pipeline/appconfig';

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
      const config = Config.get();

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
        console.log('✅ Database connection initialized successfully');
        this.logConnectionConfig(poolConfig);
      }
    } catch (error) {
      console.error('❌ Failed to initialize database connection:', error);
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
        console.log('✅ Database connection test successful');
      }

      return result.rows.length > 0;
    } catch (error) {
      console.error('❌ Database connection test failed:', error);
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
      console.warn('⚠️  Connection is already shutting down');
      return;
    }

    this.isShuttingDown = true;

    try {
      if (this.options.enableLogging) {
        console.log('🔄 Closing database connection pool...');
        const stats = this.getStats();
        console.log(`📊 Pool stats - Total: ${stats.totalCount}, Idle: ${stats.idleCount}, Waiting: ${stats.waitingCount}`);
      }

      // Set a timeout for graceful shutdown
      const closePromise = this.pool.end();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection close timeout')), timeout),
      );

      await Promise.race([closePromise, timeoutPromise]);

      if (this.options.enableLogging) {
        console.log('✅ Database connection closed successfully');
      }
    } catch (error) {
      console.error('❌ Error closing database connection:', error);
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
      console.error('❌ Unexpected error on idle client:', err);

      if (this.options.enableAutoRetry && this.connectionAttempts < this.options.maxRetries) {
        void this.handleConnectionError(err).catch((retryErr) => {
          console.error('❌ Connection retry error:', retryErr);
        });
      }
    });

    this.pool.on('connect', () => {
      this.connectionAttempts = 0; // Reset on successful connection

      if (this.options.enableLogging) {
        console.log('✅ New database connection established');
      }
    });

    this.pool.on('acquire', () => {
      if (this.options.enableLogging) {
        // Only log if we want verbose connection tracking
        // console.log('🔄 Client acquired from pool');
      }
    });

    this.pool.on('remove', () => {
      if (this.options.enableLogging) {
        console.log('🗑️  Client removed from pool');
      }
    });
  }

  /**
   * Handles connection errors with retry logic
   */
  private async handleConnectionError(error: Error): Promise<void> {
    this.connectionAttempts++;

    console.error(
      `⚠️  Connection error (attempt ${this.connectionAttempts}/${this.options.maxRetries}):`,
      error.message,
    );

    if (this.connectionAttempts < this.options.maxRetries) {
      const delay = this.options.retryDelay * this.connectionAttempts;
      console.log(`🔄 Retrying connection in ${delay}ms...`);

      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await this.testConnection();
        console.log('✅ Connection restored');
      } catch (retryError) {
        console.error('❌ Retry failed:', retryError);
      }
    } else {
      console.error('❌ Max connection retry attempts reached');
    }
  }

  /**
   * Logs connection configuration (sanitized)
   */
  private logConnectionConfig(config: PoolConfig): void {
    console.log('📊 Database Configuration:');
    console.log(`  Host: ${config.host}:${config.port}`);
    console.log(`  Database: ${config.database}`);
    console.log(`  User: ${config.user}`);
    console.log(`  Max Pool Size: ${config.max}`);
    console.log(`  Idle Timeout: ${config.idleTimeoutMillis}ms`);
    console.log(`  Connection Timeout: ${config.connectionTimeoutMillis}ms`);
    console.log(`  SSL: ${config.ssl ? 'enabled' : 'disabled'}`);
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
export const db = Connection.getInstance().db;

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