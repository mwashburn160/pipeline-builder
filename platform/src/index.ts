// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import net from 'net';
import { createLogger } from '@pipeline-builder/api-core';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

import { config } from './config';
import { notFoundHandler, errorHandler } from './middleware';
import { authRoutes, oauthRoutes, userRoutes, usersRoutes, organizationRoutes, organizationsRoutes, invitationRoutes, pluginRoutes, pipelineRoutes, logRoutes, auditRoutes, configRoutes } from './routes';

const logger = createLogger('platform-api');

/** Express application instance */
const app = express();

/** Prometheus metrics setup */
const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: 'platform' });
collectDefaultMetrics({ register: metricsRegistry });

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

/** Extract client IP from request, handling proxies */
function extractClientIp(req: express.Request): string {
  let ip = req.ip;
  if (req.headers['x-forwarded-for']) {
    ip = (req.headers['x-forwarded-for'] as string).split(',')[0].trim();
  }
  if (!ip || net.isIPv6(ip)) {
    return ipKeyGenerator(ip || 'unknown', 64);
  }
  return ip;
}

/**
 * Best-effort organizationId extraction for rate-limit bucketing.
 *
 * Runs BEFORE auth middleware, so this peeks at the Bearer token without
 * verifying the signature. Used only as a rate-limit key; real authorization
 * still happens in requireAuth. Falls back to IP-based keying when:
 *   - no Bearer token,
 *   - the token is malformed,
 *   - the payload doesn't include organizationId.
 *
 * Net effect: a single noisy authenticated org consumes its own quota window
 * instead of degrading every other tenant sharing an IP (NAT / corp gateway).
 */
function rateLimitKey(req: express.Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const parts = token.split('.');
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { organizationId?: string };
        if (typeof payload.organizationId === 'string' && payload.organizationId.length > 0) {
          return `org:${payload.organizationId.toLowerCase()}`;
        }
      } catch {
        // Malformed JWT — fall through to IP keying.
      }
    }
  }
  return `ip:${extractClientIp(req)}`;
}

/** General rate limiter */
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  keyGenerator: rateLimitKey,
  message: { success: false, statusCode: 429, message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Strict rate limiter for auth endpoints (login, register, OAuth) — IP-based since user is not yet authenticated. */
const authLimiter = rateLimit({
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  keyGenerator: extractClientIp,
  message: { success: false, statusCode: 429, message: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Request ID middleware — attaches a unique ID to each request for log correlation */
function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.headers['x-request-id'] = requestId;
  next();
}

/** Configure security and parsing middleware */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(config.cors));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.set('trust proxy', config.server.trustProxy);
app.use(requestIdMiddleware);

/** Prometheus metrics middleware — records request duration and count */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/metrics' || req.path === '/health') {
    next();
    return;
  }
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? req.baseUrl + req.route.path : req.path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

app.use(limiter);

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  const mongodb = mongoose.connection.readyState === 1 ? 'connected'
    : mongoose.connection.readyState === 0 ? 'unknown'
      : 'disconnected';
  const status = mongodb === 'disconnected' ? 503 : 200;
  res.status(status).json({ status: status === 200 ? 'ok' : 'degraded', dependencies: { mongodb } });
});

/**
 * Prometheus metrics endpoint for monitoring and observability.
 *
 * @route GET /metrics
 * @returns Prometheus text exposition format
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
});

/*
 * API Routes
 * Note: nginx strips /api prefix before proxying to this service
 */
app.use('/auth', authLimiter, authRoutes);
app.use('/auth/oauth', authLimiter, oauthRoutes);
app.use('/user', userRoutes);
app.use('/users', usersRoutes);
app.use('/organization', organizationRoutes);
app.use('/organizations', organizationsRoutes);
app.use('/invitation', invitationRoutes);
app.use('/plugin', pluginRoutes);
app.use('/pipeline', pipelineRoutes);
app.use('/logs', logRoutes);
app.use('/audit', auditRoutes);
app.use('/config', configRoutes);

/** Error handling middleware (must be registered last) */
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Initialize MongoDB connection and start the HTTP server.
 * Sets up graceful shutdown handlers for SIGINT and SIGTERM signals.
 *
 * @returns Promise that resolves when server is listening
 * @throws Exits process with code 1 on startup failure
 */
async function startServer(): Promise<void> {
  try {
    logger.info('Starting platform microservice...');

    // Configure Mongoose
    mongoose.set('strictQuery', true);

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });

    // Connect to MongoDB
    await mongoose.connect(config.mongodb.uri);
    logger.info('MongoDB connection established');

    // Start HTTP server
    const server = app.listen(config.app.port, () => {
      logger.info(`Platform microservice listening on port: ${config.app.port}`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await mongoose.connection.close(false);
          logger.info('MongoDB connection closed');
        } catch (error) {
          logger.error('Error closing MongoDB:', error);
        }

        process.exit(0);
      });

      // Force shutdown after timeout
      const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '15000', 10);
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, shutdownTimeoutMs);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start
startServer().catch((error) => {
  logger.error('Unhandled error during startup:', error);
  process.exit(1);
});