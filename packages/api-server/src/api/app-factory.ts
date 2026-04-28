// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, generateOpenApiSpec, ErrorCode, createLogger, getOrgId, createHealthRouter } from '@pipeline-builder/api-core';
import type { OpenApiSpecOptions } from '@pipeline-builder/api-core';
import { Config, CoreConstants, getConnection } from '@pipeline-builder/pipeline-core';
import compression from 'compression';
import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { v7 as uuid } from 'uuid';
import { etagMiddleware } from './etag-middleware';
import { idempotencyMiddleware } from './idempotency-middleware';
import { metricsMiddleware, metricsHandler } from './metrics';
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
  /** Redis URL for shared rate-limit state (e.g. 'redis://host:6379'). In-memory when omitted. */
  redisUrl?: string;
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
  /** Health check dependency checker — if provided, /health reports dependency status */
  checkDependencies?: () => Promise<Record<string, 'connected' | 'disconnected' | 'unknown'>>;
  /** Enable OpenAPI spec at /docs/openapi.json and Swagger UI at /docs (default: true) */
  enableOpenApi?: boolean;
  /** OpenAPI spec customization options */
  openApiOptions?: OpenApiSpecOptions;
  /** Enable gzip/deflate response compression (default: true) */
  enableCompression?: boolean;
  /**
   * Extra warmup callbacks invoked by `GET /warmup` in addition to the
   * default Postgres ping. Use for services that depend on Mongo, Redis,
   * SQS, etc. — pre-warming opens connection pools before real traffic
   * arrives. Each callback should resolve when its dependency is ready;
   * any rejection causes /warmup to return 503.
   */
  warmupHooks?: Array<() => Promise<void>>;
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
    checkDependencies,
    enableOpenApi = true,
    openApiOptions,
    enableCompression = true,
    warmupHooks = [],
  } = options;

  // Fail fast if JWT_SECRET is not configured — prevents silent auth failures at runtime
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required. Set it before starting the server.');
  }

  // Initialize OpenTelemetry tracing once per process if OTEL_TRACING_ENABLED=true.
  // Safe to call multiple times — initTracing() is idempotent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { initTracing } = require('./tracing');
  initTracing(process.env.SERVICE_NAME || 'api');

  const serverConfig = Config.get('server');
  const app = express();

  // Security middleware.
  //
  // Swagger UI needs unsafe-inline + unsafe-eval for its bundled scripts —
  // but we only relax CSP that far when (a) OpenAPI is enabled AND (b) we're
  // not in production. In prod, Swagger should be served behind a separate
  // host or auth-gated route; the main app keeps the strict CSP so a Stored
  // XSS in any handler can't `eval()` arbitrary script.
  const isProduction = process.env.NODE_ENV === 'production';
  const allowSwaggerCsp = enableOpenApi && !isProduction;
  if (enableHelmet) {
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: allowSwaggerCsp
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

  // Response compression (gzip/deflate) — skip SSE streams
  if (enableCompression) {
    app.use(compression({
      filter: (req: Request, res: Response) => {
        // Don't compress SSE streams
        if (req.headers.accept === 'text/event-stream') return false;
        return compression.filter(req, res);
      },
      threshold: CoreConstants.COMPRESSION_THRESHOLD_BYTES,
    }));
  }

  // ETag support for conditional GET requests (304 Not Modified)
  app.use(etagMiddleware());

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

  // Health check registered before rate limiter so it is never throttled
  app.use(createHealthRouter({
    serviceName: process.env.SERVICE_NAME || 'api',
    checkDependencies,
  }));

  // Warm-up endpoint — pre-opens connection pools so the first real request
  // doesn't pay cold-start latency. Always pings Postgres; services using
  // Mongo / Redis / SQS pass `warmupHooks` so those are warmed in parallel.
  app.get('/warmup', async (_req: Request, res: Response) => {
    try {
      await Promise.all([
        getConnection().testConnection(),
        ...warmupHooks.map((hook) => hook()),
      ]);
      sendSuccess(res, 200, { warmed: true, hooks: warmupHooks.length });
    } catch {
      sendError(res, 503, 'Warmup failed');
    }
  });

  // Prometheus metrics endpoint — always registered (never throttled)
  app.get('/metrics', metricsHandler());

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

  // Rate limiting — uses Redis when redisUrl is provided for shared state across instances
  if (enableRateLimit) {
    const rateLimitConfig = Config.get('rateLimit');

    const rateLimitOptions: Parameters<typeof rateLimit>[0] = {
      max: rateLimitConfig.max,
      windowMs: rateLimitConfig.windowMs,
      standardHeaders: true,
      legacyHeaders: false,
      validate: { keyGeneratorIpFallback: false },
      // Skip rate limiting for internal service calls (init scripts, inter-service)
      skip: (req: Request) => req.headers['x-internal-service'] === 'true',
      // Per-org key: use orgId from JWT when available, fall back to IP
      keyGenerator: (req: Request) => {
        return getOrgId(req) || req.ip || 'anon';
      },
      handler: (_req: Request, res: Response) => {
        sendError(res, 429, 'Too many requests, please try again later.', ErrorCode.RATE_LIMIT_EXCEEDED);
      },
    };

    // Use Redis store when available for shared state across instances
    if (options.redisUrl) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { RedisStore } = require('rate-limit-redis');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Redis = require('ioredis');
        const redisClient = new Redis(options.redisUrl);
        rateLimitOptions.store = new RedisStore({
          sendCommand: (...args: string[]) => redisClient.call(...args),
        });
      } catch {
        createLogger('RateLimit').warn('Redis store unavailable, falling back to in-memory rate limiting');
      }
    }

    app.use(rateLimit(rateLimitOptions));
  }

  // Express request timeout — uses CoreConstants to share the same default as Lambda handlers
  const timeoutMs = CoreConstants.HANDLER_TIMEOUT_MS;
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        sendError(res, 503, 'Request timeout');
      }
    });
    next();
  });

  // Request duration logging
  const durationLogger = createLogger('request-duration');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      durationLogger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: duration,
        requestId: req.requestId,
      });
    });
    next();
  });

  // Prometheus metrics middleware — records request duration and count
  app.use(metricsMiddleware());

  // Idempotency key support for mutation endpoints
  app.use(idempotencyMiddleware());

  // SSE logs endpoint
  app.get('/logs/:requestId', sseManager.middleware());

  return { app, sseManager };
}
