// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { previousSecretStates, SECRET_ROTATION_PREVIOUS_GAUGE } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import type { Request, Response, NextFunction } from 'express';
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

const SERVICE_NAME = (Config.getAny('observability') as { serviceName: string }).serviceName;

/** Shared Prometheus registry */
const register = new Registry();

// Set default labels for all metrics
register.setDefaultLabels({ service: SERVICE_NAME });

// Collect default Node.js process metrics (CPU, memory, heap, event loop lag, GC)
collectDefaultMetrics({ register });

/**
 * Register the `secret_rotation_previous_set{secret}` gauge on `registry`: 1
 * while a secret's `*_PREVIOUS` rotation value is still set, 0 otherwise. The
 * value is read from api-core's probe registry at scrape time, so it always
 * reflects the live process. Exported so platform (own registry) exposes the
 * identical series; the `SecretRotationPreviousLingering` alert keys on it.
 */
export function registerSecretRotationGauge(registry: Registry): Gauge<'secret'> {
  return new Gauge({
    name: SECRET_ROTATION_PREVIOUS_GAUGE,
    help: '1 while a secret rotation previous value (e.g. SECRET_ENCRYPTION_KEY_PREVIOUS) or a retiring signing key is still accepted; see docs/runbooks/secret-rotation.md',
    labelNames: ['secret'] as const,
    registers: [registry],
    collect() {
      for (const { secret, previousSet } of previousSecretStates()) {
        this.set({ secret }, previousSet ? 1 : 0);
      }
    },
  });
}

registerSecretRotationGauge(register);

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
 * Per-org HTTP request counter — SAMPLED to keep Prometheus cardinality
 * under control. Cardinality of `org_id * method * route * status_code`
 * grows multiplicatively; with N orgs * 50 routes * 5 status_codes that's
 * 250×N series. We sample 1-in-N requests (configurable via
 * `HTTP_METRICS_ORG_SAMPLE_RATE`, default 0 = off).
 *
 * Operators answer "what's org X's p99?" via separate per-org histograms
 * scraped at a lower rate, OR via Loki LogQL queries against the
 * unsampled access-log stream. This counter is the fast-path "noisy
 * neighbor detection" — operators alert when one org's request rate
 * deviates from the fleet median.
 *
 * NOT a histogram: histogram label cardinality is even more sensitive
 * (each bucket is a separate series). If per-org latency percentiles are
 * needed later, add a separate histogram with a coarser bucket set and
 * lower sample rate.
 */
const httpRequestsByOrgTotal = new Counter({
  name: 'http_requests_by_org_total',
  help: 'Sampled per-org HTTP request count (sample rate via HTTP_METRICS_ORG_SAMPLE_RATE)',
  labelNames: ['method', 'route', 'status_code', 'org_id'] as const,
  registers: [register],
});

/**
 * Sample rate for the per-org counter. 1.0 = every request, 0.0 = disabled.
 * Parsed once at module load — operators tune by restarting the service.
 *
 * Defaults to 0 (OFF). `org_id` is an UNBOUNDED, tenant-identifying label and
 * prom-client counters never expire, so at 1.0 every service accumulates a
 * series per (org × route × status) for the process lifetime, and `/metrics` —
 * which is not auth-gated — enumerates every tenant id along with its request
 * volume and error rate to anyone who can reach the port.
 *
 * Turn it on deliberately (and ideally with a sample rate well under 1.0, plus
 * `METRICS_SCRAPE_TOKEN` set) when you actually want per-org noisy-neighbour
 * detection from metrics rather than from the access-log stream.
 */
const ORG_SAMPLE_RATE = (() => {
  const raw = process.env.HTTP_METRICS_ORG_SAMPLE_RATE;
  if (raw === undefined || raw === '') return 0;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) return 0;
  return parsed;
})();

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
    // NOTE: no /metrics or /health skip needed here — both endpoints are
    // registered in app-factory BEFORE this middleware (createHealthRouter and
    // app.get('/metrics') both terminate the response), so neither ever reaches
    // this handler.
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

      // Per-org sampled counter. Skip when:
      //   - no org context on the request (anonymous / health endpoints)
      //   - sample rate is 0 (disabled)
      //   - dice roll fails
      // Using Math.random for the sampler — for unbiased low-rate sampling
      // a deterministic per-request hash would be more uniform, but at the
      // default rate of 1.0 every request lands so this is fine.
      const orgId = req.user?.organizationId;
      if (orgId && ORG_SAMPLE_RATE > 0 && Math.random() < ORG_SAMPLE_RATE) {
        httpRequestsByOrgTotal.inc({ ...labels, org_id: orgId });
      }
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

/**
 * Bucket distributions for histograms whose observations are nowhere near the
 * sub-second-to-minutes default.
 *
 * THIS TABLE EXISTS BECAUSE THE DEFAULT SILENTLY BREAKS ALERTS. The default set
 * below ends at a 300-second bucket, and `histogram_quantile` cannot interpolate
 * past the last FINITE boundary — everything above it lands in `+Inf` and the
 * quantile reads back as 300 forever. An alert of the form `> 300` on such a
 * histogram can therefore never fire, and a p90 panel flat-lines at five
 * minutes however bad things get. Nothing errors, nothing is missing from the
 * scrape, and the dashboard looks healthy: the only symptom is an alert that
 * stays quiet through an outage. `support_first_response_seconds` measures hours
 * to days and had a threshold of twelve hours sitting above a ceiling of five
 * minutes.
 *
 * So a histogram whose natural range is minutes-to-days declares its buckets
 * here, and ALERT THRESHOLDS ARE PUT ON BOUNDARIES: a threshold inside a wide
 * bucket is served by linear interpolation across that bucket, which is a guess,
 * while a threshold ON a boundary is exact. For support that means 6h (the alert)
 * and 8h (the sold target) are both boundaries, 24h is the operational guard
 * from the standard/priority rule, and 96h covers the longest legitimate wait a
 * business-day target allows — a priority case raised at 17:01 on a Friday.
 *
 * Add a metric here when its observations can exceed five minutes. The table is
 * read on FIRST USE of each name by `createMetricHelpers`, so both registries
 * (api-server's and platform's own) get the same distribution, which is the
 * drift the factory exists to prevent.
 */
const HISTOGRAM_BUCKETS: Readonly<Record<string, readonly number[]>> = {
  // 15m, 1h, 2h, 4h, 6h, 8h, 12h, 24h, 48h, 96h.
  support_first_response_seconds: [900, 3600, 7200, 14400, 21600, 28800, 43200, 86400, 172800, 345600],
  // Submission-to-decision latency is a human review queue: hours to days.
  // 15m, 1h, 4h, 12h, 1d, 2d, 4d, 7d, 14d.
  ecosystem_decision_latency_seconds: [900, 3600, 14400, 43200, 86400, 172800, 345600, 604800, 1209600],
  // Queue wait. `PluginQueueProcessingSlow` asserts p95 > 300, which the default
  // ceiling of 300 made unfireable; 300 is a boundary here so the comparison is
  // exact rather than interpolated.
  plugin_job_wait_seconds: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  // A container build. Minutes normally, far longer for a cold base image.
  plugin_build_duration_seconds: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  // A full image scan, which routinely passes five minutes on a large image.
  plugin_vuln_scan_duration_seconds: [1, 5, 15, 30, 60, 120, 300, 600, 1200],
  // CSAT, 1-5. Not a duration at all, and listed here for the same reason as
  // the others: the default buckets are sub-second, so every rating would land
  // in the same bucket and the quantile would be meaningless. One boundary per
  // possible score makes `_sum / _count` an exact average and each bucket a
  // real count. It rides the histogram rather than a counter-per-score so the
  // average needs no PromQL arithmetic over five series.
  support_satisfaction: [1, 2, 3, 4, 5],
};

/** The lazy business-metric helpers, bound to one registry. */
export interface MetricHelpers {
  incCounter(name: string, labels?: Record<string, string>, value?: number): void;
  observe(name: string, labels: Record<string, string>, value: number): void;
  setGauge(name: string, labels: Record<string, string>, value: number): void;
}

/**
 * Build `incCounter` / `observe` / `setGauge` over a caller-supplied registry.
 *
 * THE one implementation of the lazy counter/histogram/gauge maps. api-server's
 * own exports below are this factory over its module-level `register`; the
 * platform service — which runs its own Express setup instead of `createApp`,
 * and therefore owns a different registry — builds the identical helpers over
 * its own. Without the factory the two drift: they differ today only in the
 * histogram buckets, which is exactly the kind of difference nobody notices
 * until a dashboard reads wrong on one service.
 *
 * `registry` may be a thunk, for a registry that is injected after module load
 * (platform wires its own on app boot). The thunk is called on the FIRST use of
 * each metric name, never at import time, so building the helpers has no side
 * effect of its own.
 */
export function createMetricHelpers(registry: Registry | (() => Registry)): MetricHelpers {
  const registryOf = (): Registry => (typeof registry === 'function' ? registry() : registry);
  const counters = new Map<string, Counter<string>>();
  const histograms = new Map<string, Histogram<string>>();
  const gauges = new Map<string, Gauge<string>>();

  return {
    incCounter(name, labels = {}, value = 1) {
      let counter = counters.get(name);
      if (!counter) {
        counter = new Counter({
          name,
          help: humanizeName(name),
          labelNames: Object.keys(labels),
          registers: [registryOf()],
        });
        counters.set(name, counter);
      }
      counter.inc(labels, value);
    },

    observe(name, labels, value) {
      let hist = histograms.get(name);
      if (!hist) {
        hist = new Histogram({
          name,
          help: humanizeName(name),
          labelNames: Object.keys(labels),
          // Default buckets target sub-second through several-minute
          // observations. Anything that can exceed five minutes MUST declare its
          // own distribution in `HISTOGRAM_BUCKETS` above — past the last finite
          // boundary a quantile reads back as that boundary, so a threshold
          // beyond it never fires.
          buckets: [...(HISTOGRAM_BUCKETS[name] ?? [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300])],
          registers: [registryOf()],
        });
        histograms.set(name, hist);
      }
      hist.observe(labels, value);
    },

    setGauge(name, labels, value) {
      let gauge = gauges.get(name);
      if (!gauge) {
        gauge = new Gauge({
          name,
          help: humanizeName(name),
          labelNames: Object.keys(labels),
          registers: [registryOf()],
        });
        gauges.set(name, gauge);
      }
      gauge.set(labels, value);
    },
  };
}

/** This service's own helpers, over the shared module-level registry. */
const businessMetrics = createMetricHelpers(register);

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
  businessMetrics.incCounter(name, labels, value);
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
  businessMetrics.observe(name, labels, value);
}

/**
 * Set the value of a business gauge, creating it on first use. Use for
 * point-in-time observations sampled by a scraper — queue depth, active
 * connection counts, in-flight requests.
 *
 * @example
 * ```typescript
 * setGauge('plugin_queue_jobs', { queue: 'plugin-build', state: 'waiting' }, 12);
 * setGauge('plugin_queue_jobs', { queue: 'plugin-build', state: 'active' }, 3);
 * ```
 */
export function setGauge(name: string, labels: Record<string, string>, value: number): void {
  businessMetrics.setGauge(name, labels, value);
}

function humanizeName(metricName: string): string {
  // `pipelines_generated_total` → "Pipelines generated total"
  return metricName
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
