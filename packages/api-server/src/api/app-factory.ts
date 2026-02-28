/**
 * @module api/app-factory
 * @description Factory for creating pre-configured Express applications with security, rate limiting, health checks, and SSE support.
 */

import { sendSuccess, sendError, generateOpenApiSpec } from '@mwashburn160/api-core';
import type { OpenApiSpecOptions } from '@mwashburn160/api-core';
import { Config, getConnection } from '@mwashburn160/pipeline-core';
import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { v7 as uuid } from 'uuid';
import { metricsMiddleware, metricsHandler } from './metrics';
import { SSEManager } from '../http/sse-connection-manager';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

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
  /** Enable OpenAPI spec at /docs/openapi.json and Swagger UI at /docs (default: true) */
  enableOpenApi?: boolean;
  /** OpenAPI spec customization options */
  openApiOptions?: OpenApiSpecOptions;
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
 * app.post('/api/resource', requireAuth, async (req, res) => {
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
    enableOpenApi = true,
    openApiOptions,
  } = options;

  const serverConfig = Config.get('server');
  const app = express();

  // Security middleware
  if (enableHelmet) {
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Swagger UI requires unsafe-inline + unsafe-eval for its scripts
          scriptSrc: enableOpenApi
            ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
            : ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    }));
  }

  if (enableCors) {
    app.use(cors(serverConfig.cors));
  }

  // Body parsing
  if (enableJsonBody) {
    app.use(express.json({ limit: jsonLimit }));
  }

  if (enableUrlEncoded) {
    app.use(express.urlencoded({ extended: true, limit: urlEncodedLimit }));
  }

  // Trust proxy (must be set before rate limiter so req.ip resolves correctly)
  app.set('trust proxy', serverConfig.trustProxy);

  // Request ID — prefer existing header from nginx, otherwise generate one
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers['x-request-id'];
    const requestId = (Array.isArray(hdr) ? hdr[0] : hdr) || uuid();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

  // Health check and metrics registered before rate limiter so they are never throttled
  if (!skipDefaultHealthCheck) {
    let cachedHealth: { healthy: boolean; checkedAt: number } | null = null;
    const HEALTH_CACHE_TTL_MS = 10_000; // 10s

    app.get('/health', async (_req: Request, res: Response) => {
      try {
        const now = Date.now();
        if (!cachedHealth || now - cachedHealth.checkedAt > HEALTH_CACHE_TTL_MS) {
          const connection = getConnection();
          const isHealthy = await connection.testConnection();
          cachedHealth = { healthy: isHealthy, checkedAt: now };
        }

        const healthData = {
          status: cachedHealth.healthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          database: cachedHealth.healthy ? 'connected' : 'disconnected',
        };

        if (cachedHealth.healthy) {
          sendSuccess(res, 200, healthData);
        } else {
          sendError(res, 503, 'Service unhealthy', undefined, healthData);
        }
      } catch (error) {
        cachedHealth = { healthy: false, checkedAt: Date.now() };
        sendError(res, 503, 'Service unhealthy', undefined, {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    app.get('/metrics', metricsHandler());
  }

  // OpenAPI spec and Swagger UI (registered before rate limiter)
  if (enableOpenApi) {
    const spec = generateOpenApiSpec(openApiOptions);
    app.get('/docs/openapi.json', (_req: Request, res: Response) => {
      res.json(spec);
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, {
      customSiteTitle: openApiOptions?.title ?? 'Pipeline Builder API Docs',
    }));
  }

  // Rate limiting
  if (enableRateLimit) {
    const rateLimitConfig = Config.get('rateLimit');
    const limiter = rateLimit({
      max: rateLimitConfig.max,
      windowMs: rateLimitConfig.windowMs,
      message: 'Too many requests from this IP, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.use(limiter);
  }

  // Express request timeout (env: HANDLER_TIMEOUT_MS, default: 30s)
  const timeoutMs = parseInt(process.env.HANDLER_TIMEOUT_MS || '30000', 10);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        sendError(res, 503, 'Request timeout');
      }
    });
    next();
  });

  // Prometheus metrics middleware — records request duration and count
  app.use(metricsMiddleware());

  // SSE logs endpoint
  app.get('/logs/:requestId', sseManager.middleware());

  return { app, sseManager };
}
