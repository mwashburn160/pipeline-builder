/**
 * @module metrics
 * @description Prometheus metrics middleware for Express services.
 *
 * Collects HTTP request duration, request counts, and default Node.js
 * process metrics (CPU, memory, heap, event loop lag, GC).
 *
 * Usage:
 * ```typescript
 * import { metricsMiddleware, metricsHandler } from './metrics';
 *
 * app.use(metricsMiddleware());
 * app.get('/metrics', metricsHandler());
 * ```
 */

import { Request, Response, NextFunction } from 'express';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown';

/** Shared Prometheus registry */
const register = new Registry();

// Set default labels for all metrics
register.setDefaultLabels({ service: SERVICE_NAME });

// Collect default Node.js process metrics (CPU, memory, heap, event loop lag, GC)
collectDefaultMetrics({ register });

/** HTTP request duration histogram (seconds) */
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/** HTTP request counter */
const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

/**
 * Normalize an Express route path to prevent label cardinality explosion.
 *
 * Uses Express's matched route pattern (e.g. `/plugins/:id`) when available,
 * otherwise falls back to the raw path with UUID/numeric segments replaced.
 */
function normalizeRoute(req: Request): string {
  // Prefer Express matched route pattern
  if (req.route?.path) {
    return req.baseUrl + req.route.path;
  }

  // Fallback: replace UUIDs and numeric IDs with :id
  return req.path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

/**
 * Express middleware that records request duration and count.
 *
 * Must be registered before route handlers so `res.on('finish')` fires
 * after the response is sent.
 */
export function metricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip recording the /metrics and /health endpoints themselves
    if (req.path === '/metrics' || req.path === '/health') {
      next();
      return;
    }

    const end = httpRequestDuration.startTimer();

    res.on('finish', () => {
      const route = normalizeRoute(req);
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };

      end(labels);
      httpRequestsTotal.inc(labels);
    });

    next();
  };
}

/**
 * Express handler that returns Prometheus metrics in text exposition format.
 */
export function metricsHandler() {
  return async (_req: Request, res: Response): Promise<void> => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  };
}
