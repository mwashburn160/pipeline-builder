// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, installCrashHandlers, isValidTier, mongoSanitize, sendError } from '@pipeline-builder/api-core';
import { withTenantContext } from '@pipeline-builder/api-server';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

import { config } from './config/index.js';
import { notFoundHandler, errorHandler } from './middleware/index.js';
import {
  isWriteBlockedByImpersonation,
  IMPERSONATION_READ_ONLY_MESSAGE,
  IMPERSONATION_READ_ONLY_CODE,
} from './middleware/require-write-access.js';
import { authRoutes, oauthRoutes, userRoutes, usersRoutes, organizationRoutes, organizationsRoutes, invitationRoutes, logRoutes, auditRoutes, configRoutes, observabilityRoutes, dashboardRoutes, orgIdpRoutes, orgKmsConfigRoutes, orgNamespaceRoutes, userGrantsRoutes, adminSummaryRoutes, impersonateRoutes } from './routes/index.js';

const logger = createLogger('platform-api');

// NOTE: OpenTelemetry is initialized by the `otel-bootstrap.js` preload
// (`node -r ./otel-bootstrap.js index.js` — see Dockerfile / start script),
// NOT here. It must run before express/http are required so auto-instrumentation
// can patch them; once active, the request's trace id flows onto audit events
// (helpers/audit.ts) via currentTraceId(). Gated by OTEL_TRACING_ENABLED.

/** Express application instance */
const app = express();

/** Prometheus metrics setup */
const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: 'platform' });
collectDefaultMetrics({ register: metricsRegistry });

// Wire the platform-local business-metric helpers (incCounter, observe,
// setGauge in./observability/metrics) to this registry so call sites in
// controllers + the periodic scraper publish to the same /metrics endpoint
// exposed below.
// Deferred (post-registry) load via top-level await — keeps the original lazy
// ordering (register the registry before the metrics module's call sites bind).
const { setMetricsRegistry } = await import('./observability/metrics.js');
setMetricsRegistry(metricsRegistry);
const { startPlatformMetricsScraper, stopPlatformMetricsScraper } = await import('./observability/scraper.js');
startPlatformMetricsScraper();
process.once('SIGTERM', () => stopPlatformMetricsScraper());

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

/** Extract client IP from request, handling proxies.
 *
 * Always route the final value through `ipKeyGenerator` — express-rate-limit
 * 8.x's validator refuses to start if a custom keyGenerator touches `req.ip`
 * without calling this helper (the helper normalizes IPv6 addresses to a /64
 * prefix so a single user can't burn through the bucket by rotating
 * low-bits). Skipping the helper on IPv4 raises ERR_ERL_KEY_GEN_IPV6 at
 * boot time even though IPv4 doesn't need the prefixing — the validator
 * doesn't introspect; it just checks the helper was invoked. */
function extractClientIp(req: express.Request): string {
  let ip = req.ip;
  if (req.headers['x-forwarded-for']) {
    ip = (req.headers['x-forwarded-for'] as string).split(',')[0].trim();
  }
  return ipKeyGenerator(ip || 'unknown', 64);
}

/**
 * Best-effort organizationId extraction for rate-limit bucketing.
 *
 * Runs BEFORE auth middleware, so this peeks at the Bearer token without
 * verifying the signature. Used only as a rate-limit key; real authorization
 * still happens in requireAuth. Falls back to IP-based keying when * - no Bearer token,
 * - the token is malformed,
 * - the payload doesn't include organizationId.
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
        // Malformed JWT  fall through to IP keying.
      }
    }
  }
  return `ip:${extractClientIp(req)}`;
}

/**
 * Peek at the JWT payload (unverified  signature checked later in `requireAuth`)
 * to extract the issuer-stamped tier + role for rate-limit dispatching.
 * Same caveat as `rateLimitKey`: this runs BEFORE auth middleware, so it must
 * tolerate missing / malformed tokens; the limit decision falls back to the
 * developer tier when no signal is available.
 */
function peekJwtClaims(req: express.Request): {
  tier?: string;
  role?: string;
  organizationId?: string;
  organizationName?: string;
  isSuperAdmin?: boolean;
  impersonationReadOnly?: boolean;
} {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return {};
  const token = auth.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
      tier?: string;
      role?: string;
      organizationId?: string;
      organizationName?: string;
      isSuperAdmin?: boolean;
      impersonationReadOnly?: boolean;
    };
  } catch {
    return {};
  }
}

/**
 * Per-tier max calculator. JWT carries `tier` (set at issuance from the
 * org's planId); we multiply the baseline by the tier's multiplier so a
 * premium org gets proportionally more burst. Sysadmins bypass entirely
 * (see `skip` below).
 *
 * Falls back to the developer (1×) multiplier when the tier isn't on the
 * configured map  keeps newly-named tiers from accidentally getting an
 * unlimited budget.
 */
function tierLimitedMax(req: Request): number {
  const { tier } = peekJwtClaims(req);
  // `tier` is a JWT claim and arrives untyped — narrow via api-core's
  // `isValidTier` guard before indexing the strongly-typed
  // `Record<QuotaTier, number>`. Unknown tiers fall back to 1× (developer
  // baseline), keeping a renamed-but-not-deployed tier from accidentally
  // getting an unlimited budget.
  const mult: number = (tier && isValidTier(tier) ? config.rateLimit.tierMultipliers[tier] : 1) || 1;
  return Math.max(1, Math.floor(config.rateLimit.max * mult));
}

/** General rate limiter  per-tier max, keyed by org (or IP for anon callers). */
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: tierLimitedMax,
  keyGenerator: rateLimitKey,
  // Sysadmins are internal operators who legitimately make burst calls
  // (audit replays, fleet-wide scans). Bypass the limiter rather than
  // size it for the worst case. Same JWT-peek pattern as the key generator
  // so this works pre-`requireAuth`.
  skip: (req: Request) => {
    // Sysadmin bypass — checks the JWT-stamped isSuperAdmin flag (the
    // canonical signal after the system-org cutover). Unverified peek is
    // safe: the worst a tampered token can do is grant itself the
    // rate-limit bypass, and `requireAuth` later rejects it before any
    // privileged action runs.
    return peekJwtClaims(req).isSuperAdmin === true;
  },
  message: { success: false, statusCode: 429, message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Strict rate limiter for auth endpoints (login, register, OAuth)  IP-based since user is not yet authenticated. */
const authLimiter = rateLimit({
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  keyGenerator: extractClientIp,
  message: { success: false, statusCode: 429, message: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Per-org rate limiter for observability endpoints. Tighter than the general
 * limiter because every request fans out to Prometheus or Loki, and a noisy
 * tenant can degrade those upstreams for everyone else (dashboards across all
 * orgs go blank). Keys by JWT-claimed org when present, falls back to IP.
 */
const observabilityLimiter = rateLimit({
  windowMs: config.rateLimit.observability.windowMs,
  max: config.rateLimit.observability.max,
  keyGenerator: rateLimitKey,
  message: { success: false, statusCode: 429, message: 'Observability rate limit exceeded for your organization. Please slow down or batch your queries.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Request ID middleware  attaches a unique ID to each request for log correlation */
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
// Mongo operator-injection guard  Platform is Mongo-backed (users, orgs,
// invitations, audit). Strips $-prefixed keys from req.body/query/params
// so a `{"email": {"$ne": null}}` payload can't match any document.
app.use(mongoSanitize());
app.set('trust proxy', config.server.trustProxy);
app.use(requestIdMiddleware);

/**
 * Tenant-context middleware (RLS enforcement).
 *
 * Runs before any route handler so the JWT-claimed `organizationId` + role
 * are available in AsyncLocalStorage for every downstream `withTenantTx`
 * call. Same JWT-peek pattern as `peekJwtClaims`  we read the unverified
 * payload here because * 1. The signature gets checked later in `requireAuth` (route-level).
 * Route handlers never run if the JWT was tampered.
 * 2. The peeked context only matters at query time inside withTenantTx,
 * which only fires from authenticated route handlers  so a tampered
 * JWT can't bind a falsified `app.org_id` to a real query.
 * 3. Setting the context before requireAuth lets services that aren't
 * authenticated (e.g. the /alert-webhook shared-secret endpoint) still
 * get a sensible default (empty orgId, isSuperAdmin=false).
 */
// Reuses the shared `withTenantContext` helper with platform's own pre-auth resolver.
app.use(withTenantContext((req: Request) => {
  // Use the JWT-stamped isSuperAdmin flag (post system-org cutover). The peek is
  // unverified — `requireAuth` re-validates downstream. The worst a tampered token can
  // do here is set sysadmin=true and trigger RLS's sysadmin-bypass branch on a DB query
  // that the same request will then be rejected from at the route guard.
  const claims = peekJwtClaims(req);
  return { orgId: claims.organizationId, isSuperAdmin: claims.isSuperAdmin === true };
}));

/** Prometheus metrics middleware  records request duration and count */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/metrics' || req.path === '/health') {
    next();
    return;
  }
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? req.baseUrl + req.route.path: req.path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

app.use(limiter);

/**
 * Read-only impersonation gate. When the caller's JWT carries
 * `impersonationReadOnly: true` (issued by POST /admin/impersonate),
 * any non-GET request is rejected — sysadmins can "view as user X"
 * without any chance of a destructive action landing under that
 * identity. Same JWT-peek pattern as the rate limiter: the signature
 * is still verified by `requireAuth` later, but if the token is
 * malformed the peek returns {} and this middleware no-ops.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  // Shipped gate runs pre-auth, so it JWT-peeks; the decision itself is the
  // shared (and unit-tested) predicate, so this can't drift from the per-route
  // `requireWriteAccess`.
  if (isWriteBlockedByImpersonation(req.method, peekJwtClaims(req).impersonationReadOnly === true)) {
    sendError(res, 403, IMPERSONATION_READ_ONLY_MESSAGE, IMPERSONATION_READ_ONLY_CODE);
    return;
  }
  next();
});

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  const mongodb = mongoose.connection.readyState === 1 ? 'connected'
    : mongoose.connection.readyState === 0 ? 'unknown'
      : 'disconnected';
  const status = mongodb === 'disconnected' ? 503: 200;
  res.status(status).json({ status: status === 200 ? 'ok': 'degraded', dependencies: { mongodb } });
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
app.use('/logs', logRoutes);
app.use('/audit', auditRoutes);
app.use('/config', configRoutes);
app.use('/observability', observabilityLimiter, observabilityRoutes);
app.use('/dashboards', dashboardRoutes);
app.use('/admin/org-idp', orgIdpRoutes);
app.use('/admin/orgs/:orgId/kms-config', orgKmsConfigRoutes);
app.use('/admin/orgs/:orgId/k8s-namespace.yaml', orgNamespaceRoutes);
app.use('/admin/users/:id/grants', userGrantsRoutes);
app.use('/admin/summary', adminSummaryRoutes);
app.use('/admin/impersonate', impersonateRoutes);

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

    // Connect to MongoDB. Pool sizing via env (see api/billing/database.ts
    // for rationale): bound the connection ceiling so multiple replicas
    // don't exhaust Mongo's default 100-connection cap.
    const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL || '20', 10);
    const minPoolSize = parseInt(process.env.MONGO_MIN_POOL || '2', 10);
    const serverSelectionTimeoutMS = parseInt(process.env.MONGO_SERVER_SELECTION_MS || '5000', 10);
    await mongoose.connect(config.mongodb.uri, { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });
    logger.info('MongoDB connection established', { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });

    // Bootstrap super-admins from BOOTSTRAP_SUPERADMIN_EMAILS env. Awaited
    // so the loud WARN logs land before HTTP comes up — operator can see
    // immediately whether their bootstrap config landed. Idempotent + tolerant
    // of missing accounts (warns rather than fails).
    const { bootstrapSuperAdmins } = await import('./services/superadmin-bootstrap.js');
    try {
      await bootstrapSuperAdmins();
    } catch (err) {
      logger.error('Super-admin bootstrap failed (HTTP will still start)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Install the per-org KMS provider if SECRET_ENCRYPTION_PER_ORG_KMS=true.
    // Must run AFTER Mongo connects (resolver reads Organization docs) but
    // BEFORE any code path can encrypt/decrypt a secret — i.e. before HTTP
    // listens. Idempotent; no-op when the env isn't set.
    const { bootstrapPerOrgKmsProvider } = await import('./services/per-org-kms-bootstrap.js');
    try {
      bootstrapPerOrgKmsProvider();
    } catch (err) {
      // Fail-closed: misconfigured per-org KMS shouldn't silently fall back
      // to the shared master in production. Re-throw to abort startup so
      // the operator sees the misconfig immediately.
      logger.error('Per-org KMS provider bootstrap failed; aborting startup', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // Seed default dashboards into Postgres. Fire-and-forget: the seeder is
    // idempotent (insert-if-missing per `(org_id='system', name)`) and logs
    // its own warnings on failure, so a transient Postgres outage at cold
    // start doesn't block HTTP from coming up.
    const { seedDefaultDashboards } = await import('./services/dashboard-seeder.js');
    void seedDefaultDashboards();

    // Last-resort fault handlers: log + exit(1) on uncaught exception /
    // unhandled rejection so a faulted process restarts cleanly instead of
    // dying without a trace. Separate from the graceful SIGTERM path below.
    installCrashHandlers(logger);

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