import { Server } from 'http';
import { createLogger } from '@mwashburn160/api-core';
import { Config, getConnection, closeConnection } from '@mwashburn160/pipeline-core';
import { Express } from 'express';
import { SSEManager } from '../http/sse-connection-manager';

const logger = createLogger('Server');

/**
 * Options for starting a server
 */
export interface StartServerOptions {
  /** Service name for logging */
  name?: string;
  /** Port to listen on (default: from config) */
  port?: number;
  /** SSE manager for graceful shutdown */
  sseManager?: SSEManager;
  /** Shutdown timeout in milliseconds (default: 15000) */
  shutdownTimeoutMs?: number;
  /** Callback after server starts */
  onStart?: (port: number) => void;
  /** Callback before shutdown */
  onShutdown?: () => Promise<void>;
  /** Runs before database check (e.g., connectDatabase for MongoDB) */
  onBeforeStart?: () => Promise<void>;
  /** Custom database health check, or false to skip. Default: PostgreSQL testConnection */
  testDatabase?: (() => Promise<boolean>) | false;
  /** Custom database close, or false to skip. Default: PostgreSQL closeConnection */
  closeDatabase?: (() => Promise<void>) | false;
}

/**
 * Result of starting a server
 */
export interface StartServerResult {
  /** HTTP server instance */
  server: Server;
  /** Port the server is listening on */
  port: number;
  /** Function to manually trigger shutdown */
  shutdown: () => Promise<void>;
}

/**
 * Start an Express server with graceful shutdown handling
 *
 * Features:
 * - Automatic database connection testing
 * - Graceful shutdown on SIGINT/SIGTERM
 * - SSE connection cleanup
 * - Configurable shutdown timeout
 *
 * @param app - Express application
 * @param options - Server options
 * @returns Server instance and control functions
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * app.post('/api/resource', authenticateToken, handler);
 *
 * await startServer(app, {
 *   name: 'My Microservice',
 *   sseManager,
 *   onStart: (port) => console.log(`Listening on ${port}`),
 * });
 * ```
 */
export async function startServer(
  app: Express,
  options: StartServerOptions = {},
): Promise<StartServerResult> {
  const config = Config.get();
  const {
    name = 'Microservice',
    sseManager,
    shutdownTimeoutMs = 15000,
    onStart,
    onShutdown,
    onBeforeStart,
    testDatabase,
    closeDatabase,
  } = options;
  const port = options.port ?? config.server.port;

  // Validate auth configuration at server startup (not during CDK synthesis)
  Config.validateAuth(config);

  logger.info(`Starting ${name}...`);

  // Pre-start hook (e.g., connect to MongoDB)
  if (onBeforeStart) {
    await onBeforeStart();
  }

  // Test database connection
  if (testDatabase !== false) {
    const dbHealthy = testDatabase
      ? await testDatabase()
      : await getConnection().testConnection();

    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    logger.info('Database connection established');
  }

  // Start server
  const server = app.listen(port, () => {
    logger.info(`${name} listening on port: ${port}`);
    logger.info(`Platform URL: ${config.server.platformUrl}`);
    onStart?.(port);
  });

  // Shutdown handler
  const shutdown = async (signal?: string) => {
    if (signal) {
      logger.info(`${signal} received, shutting down gracefully...`);
    }

    // Custom shutdown callback
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (error) {
        logger.error('Error in onShutdown callback', { error });
      }
    }

    // Close SSE connections
    if (sseManager) {
      sseManager.shutdown();
      logger.info('SSE connections closed');
    }

    // Close HTTP server
    server.close(async () => {
      logger.info('HTTP server closed');

      // Close database connection
      if (closeDatabase !== false) {
        try {
          if (closeDatabase) {
            await closeDatabase();
          } else {
            await closeConnection();
          }
          logger.info('Database connection closed');
        } catch (error) {
          logger.error('Error closing database', { error });
        }
      }

      process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, shutdownTimeoutMs);
  };

  // Register signal handlers
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return {
    server,
    port,
    shutdown: () => shutdown(),
  };
}

/**
 * Simple server start wrapper with error handling
 *
 * @param app - Express application
 * @param options - Server options
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 * app.post('/api/resource', handler);
 *
 * void runServer(app, { name: 'My Service', sseManager });
 * ```
 */
export function runServer(app: Express, options: StartServerOptions = {}): void {
  startServer(app, options).catch((error) => {
    logger.error('Failed to start server', { error });
    process.exit(1);
  });
}
