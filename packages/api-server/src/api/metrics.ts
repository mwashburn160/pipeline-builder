// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Config } from '@pipeline-builder/pipeline-core';
import { Request, Response, NextFunction } from 'express';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const SERVICE_NAME = (Config.getAny('observability') as { serviceName: string }).serviceName;

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

// ---------------------------------------------------------------------------
// Business / domain metrics
//
// Services should emit counters for the things operators actually care about
// (pipelines generated, plugin builds completed, compliance violations,
// AI tokens consumed) — not just HTTP traffic. The helpers below register
// counters lazily on the shared registry so multiple services can call
// `incCounter('plugin_builds_total', { status: 'completed' })` without
// worrying about double-registration.
//
// Naming convention: `<domain>_<noun>_total` for counters, `_seconds` for
// histograms — matches Prometheus best-practice.
// ---------------------------------------------------------------------------

const businessCounters = new Map<string, Counter<string>>();
const businessHistograms = new Map<string, Histogram<string>>();

/**
 * Increment a business counter, creating it on first use.
 *
 * @example
 * ```typescript
 * incCounter('pipelines_generated_total', { provider: 'anthropic' });
 * incCounter('plugin_builds_total', { status: 'completed' });
 * incCounter('quota_threshold_crossed_total', { type: 'aiCalls', tier: 'pro' });
 * incCounter('compliance_violations_found_total', { severity: 'critical' });
 * ```
 */
export function incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  let counter = businessCounters.get(name);
  if (!counter) {
    counter = new Counter({
      name,
      help: humanizeName(name),
      labelNames: Object.keys(labels),
      registers: [register],
    });
    businessCounters.set(name, counter);
  }
  counter.inc(labels, value);
}

/**
 * Record an observation on a business histogram, creating it on first use.
 * Use for durations, sizes, anything where percentiles matter.
 *
 * @example
 * ```typescript
 * observe('ai_generation_duration_seconds', { provider: 'anthropic', model: 'sonnet' }, durationSec);
 * observe('plugin_build_duration_seconds', { buildType: 'docker' }, durationSec);
 * ```
 */
export function observe(name: string, labels: Record<string, string>, value: number): void {
  let hist = businessHistograms.get(name);
  if (!hist) {
    hist = new Histogram({
      name,
      help: humanizeName(name),
      labelNames: Object.keys(labels),
      // Default buckets target sub-second through several-minute observations.
      // Override by registering the histogram explicitly before first call
      // if you need a different bucket distribution.
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers: [register],
    });
    businessHistograms.set(name, hist);
  }
  hist.observe(labels, value);
}

function humanizeName(metricName: string): string {
  // `pipelines_generated_total` → "Pipelines generated total"
  return metricName
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
