import { Config, getConnection } from '@mwashburn160/pipeline-core';
import cors from 'cors';
import express, { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { SSEManager } from '../http/sse-connection-manager';

/**
 * Options for creating an Express application
 */
export interface CreateAppOptions {
  /** Enable CORS (default: true) */
  enableCors?: boolean;
  /** Enable Helmet security headers (default: true) */
  enableHelmet?: boolean;
  /** Enable rate limiting (default: true) */
  enableRateLimit?: boolean;
  /** Enable JSON body parsing (default: true) */
  enableJsonBody?: boolean;
  /** JSON body size limit (default: '1mb') */
  jsonLimit?: string;
  /** Enable URL-encoded body parsing (default: true) */
  enableUrlEncoded?: boolean;
  /** URL-encoded body size limit (default: '1mb') */
  urlEncodedLimit?: string;
  /** Custom SSE manager instance */
  sseManager?: SSEManager;
  /** Skip default PostgreSQL health/metrics endpoints (default: false).
   *  When true, the service should provide its own health check. */
  skipDefaultHealthCheck?: boolean;
}

/**
 * Result of creating an Express application
 */
export interface CreateAppResult {
  /** Configured Express application */
  app: Express;
  /** SSE manager instance */
  sseManager: SSEManager;
}

/**
 * Create and configure an Express application with common middleware
 *
 * Sets up:
 * - CORS with configured origins
 * - Helmet security headers
 * - Rate limiting
 * - JSON and URL-encoded body parsing
 * - Trust proxy settings
 * - Health check endpoint (/health)
 * - Metrics endpoint (/metrics)
 * - SSE logs endpoint (/logs/:requestId)
 *
 * @param options - Configuration options
 * @returns Configured Express app and SSE manager
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * app.post('/api/resource', authenticateToken, async (req, res) => {
 *   // Your route handler
 * });
 *
 * startServer(app, { name: 'My Service' });
 * ```
 */
export function createApp(options: CreateAppOptions = {}): CreateAppResult {
  const {
    enableCors = true,
    enableHelmet = true,
    enableRateLimit = true,
    enableJsonBody = true,
    jsonLimit = '1mb',
    enableUrlEncoded = true,
    urlEncodedLimit = '1mb',
    sseManager = new SSEManager(),
    skipDefaultHealthCheck = false,
  } = options;

  const config = Config.get();
  const app = express();

  // Security middleware
  if (enableHelmet) {
    app.use(helmet({ contentSecurityPolicy: false }));
  }

  if (enableCors) {
    app.use(cors(config.server.cors));
  }

  // Body parsing
  if (enableJsonBody) {
    app.use(express.json({ limit: jsonLimit }));
  }

  if (enableUrlEncoded) {
    app.use(express.urlencoded({ extended: true, limit: urlEncodedLimit }));
  }

  // Trust proxy (must be set before rate limiter so req.ip resolves correctly)
  app.set('trust proxy', config.server.trustProxy);

  // Rate limiting
  if (enableRateLimit) {
    const limiter = rateLimit({
      max: config.rateLimit.max,
      windowMs: config.rateLimit.windowMs,
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.use(limiter);
  }

  // Default PostgreSQL health/metrics endpoints (skipped when service provides its own)
  if (!skipDefaultHealthCheck) {
    app.get('/health', async (_req: Request, res: Response) => {
      try {
        const connection = getConnection();
        const isHealthy = await connection.testConnection();

        res.status(isHealthy ? 200 : 503).json({
          status: isHealthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          database: isHealthy ? 'connected' : 'disconnected',
        });
      } catch (error) {
        res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    app.get('/metrics', (_req: Request, res: Response) => {
      const connection = getConnection();
      const stats = connection.getStats();

      res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        database: {
          totalConnections: stats.totalCount,
          idleConnections: stats.idleCount,
          waitingConnections: stats.waitingCount,
        },
      });
    });
  }

  // SSE logs endpoint
  app.get('/logs/:requestId', sseManager.middleware());

  return { app, sseManager };
}
