import { Server } from 'http';
import { Config, getConnection, closeConnection } from '@mwashburn160/pipeline-core';
import { Express } from 'express';
import { SSEManager } from '../http/sse-connection-manager';

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
  } = options;
  const port = options.port ?? config.server.port;

  console.log(`[Server] Starting ${name}...`);

  // Test database connection
  const connection = getConnection();
  const dbHealthy = await connection.testConnection();

  if (!dbHealthy) {
    throw new Error('Database connection failed');
  }

  console.log('[Server] Database connection established');

  // Start server
  const server = app.listen(port, () => {
    console.log(`✅ ${name} listening on port: ${port}`);
    console.log(`✅ Platform URL: ${config.server.platformUrl}`);
    onStart?.(port);
  });

  // Shutdown handler
  const shutdown = async (signal?: string) => {
    if (signal) {
      console.log(`\n${signal} received, shutting down gracefully...`);
    }

    // Custom shutdown callback
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (error) {
        console.error('❌ Error in onShutdown callback:', error);
      }
    }

    // Close SSE connections
    if (sseManager) {
      sseManager.shutdown();
      console.log('✅ SSE connections closed');
    }

    // Close HTTP server
    server.close(async () => {
      console.log('✅ HTTP server closed');

      // Close database connection
      try {
        await closeConnection();
        console.log('✅ Database connection closed');
      } catch (error) {
        console.error('❌ Error closing database:', error);
      }

      process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
      console.error('❌ Forced shutdown after timeout');
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
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}
