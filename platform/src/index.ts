// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createHealthRouter, createLogger, installCrashHandlers, isValidTier, mongoSanitize, sendError } from '@pipeline-builder/api-core';
import { withTenantContext, readinessGuard, setReady, isReady, mongoHealthCheck } from '@pipeline-builder/api-server';
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
import { authRoutes, oauthRoutes, userRoutes, usersRoutes, organizationRoutes, organizationsRoutes, invitationRoutes, logRoutes, auditRoutes, notifyEmailRoutes, configRoutes, observabilityRoutes, dashboardRoutes, orgIdpRoutes, orgKmsConfigRoutes, orgNamespaceRoutes, userGrantsRoutes, adminSummaryRoutes, impersonateRoutes } from './routes/index.js';

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
// Health + readiness, standardized on the shared router (replacing platform's
// bespoke /health): GET /health = liveness (200 while the process answers),
// GET /ready = readiness (503 while Mongo is disconnected). Mounted before the
// tenant/auth/rate-limit chain so probes are never gated or throttled.
app.use(createHealthRouter({
  serviceName: 'platform',
  checkDependencies: mongoHealthCheck(mongoose.connection),
}));

// Readiness guard — 503s business routes until Mongo connects (and the
// post-connect bootstraps finish). Critically preserves the "per-org KMS
// installed before any secret is served" invariant: `ready` is only set true
// after that bootstrap, so no secret-touching request is served before it.
//
// Narrow allowlist (NOT the shared default): platform serves a tenant log
// query API at `/logs`, which must be gated like any other Mongo-backed route.
// The default bypass list includes `/logs` for api-server's SSE log relay,
// which platform does not have.
app.use(readinessGuard(['/health', '/ready', '/metrics']));

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
  if (req.path === '/metrics' || req.path === '/health' || req.path === '/ready') {
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
app.use('/internal/notify-email', notifyEmailRoutes);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MONGO_RETRY_BASE_MS = 1000;
const MONGO_RETRY_MAX_MS = 10000;
const READINESS_MONITOR_INTERVAL_MS = parseInt(process.env.READINESS_MONITOR_INTERVAL_MS || '15000', 10);

/**
 * Establish MongoDB + run the post-connect bootstraps in the BACKGROUND, then
 * flip readiness. Retries a cold Mongo with capped backoff instead of
 * crash-looping the process — the readiness guard 503s business traffic until
 * this completes, so nothing is served against a disconnected datastore.
 *
 * Ordering invariant preserved: per-org KMS is installed BEFORE `setReady(true)`,
 * so the guard never lets a secret-touching request through before KMS is ready.
 *
 * This intentionally mirrors api-server's `superviseDependencies` (server.ts)
 * — keep the retry/monitor behaviour in sync. It is NOT shared because platform
 * interleaves fail-closed bootstraps (per-org KMS aborts via `process.exit`)
 * between connect and ready, whereas the shared helper treats every
 * `onBeforeStart` failure as a RETRYABLE dependency error — which would loop a
 * KMS misconfig forever instead of surfacing it.
 */
async function initDependencies(): Promise<void> {
  // Pool sizing via env (see api/billing/database.ts for rationale): bound the
  // connection ceiling so multiple replicas don't exhaust Mongo's default cap.
  const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL || '20', 10);
  const minPoolSize = parseInt(process.env.MONGO_MIN_POOL || '2', 10);
  const serverSelectionTimeoutMS = parseInt(process.env.MONGO_SERVER_SELECTION_MS || '5000', 10);

  let delay = MONGO_RETRY_BASE_MS;
  for (;;) {
    try {
      await mongoose.connect(config.mongodb.uri, { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });
      break;
    } catch (err) {
      logger.warn(`MongoDB connect failed, retrying in ${delay}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
      delay = Math.min(delay * 2, MONGO_RETRY_MAX_MS);
    }
  }
  logger.info('MongoDB connection established', { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });

  // Bootstrap super-admins from BOOTSTRAP_SUPERADMIN_EMAILS (idempotent,
  // non-fatal — warns rather than fails on missing accounts).
  const { bootstrapSuperAdmins } = await import('./services/superadmin-bootstrap.js');
  try {
    await bootstrapSuperAdmins();
  } catch (err) {
    logger.error('Super-admin bootstrap failed (service will still come ready)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Backfill the single-source RBAC "Roles" model (idempotent, cheap on a
  // no-op): populate built-in Roles' permission bundles and ensure every active
  // member holds the Role matching their coarse role, so users who relied on the
  // now-removed role baseline keep their permissions. Guarded — a partial
  // failure logs and boot continues (this is never fatal).
  const { backfillRbacRoles } = await import('./services/rbac-backfill.js');
  try {
    await backfillRbacRoles();
  } catch (err) {
    logger.error('RBAC Roles backfill failed (service will still come ready)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Reconcile paid-signup billing bootstraps that failed fail-open: orgs that
  // selected a paid plan at signup while billing was unavailable carry a durable
  // `pendingBillingPlanId` marker. Drain once at boot (fire-and-forget so a
  // billing outage never delays readiness) + on a guarded interval, so the
  // provisioning eventually happens instead of the org silently staying
  // developer-tier with no bill. No-ops when billing is disabled. Idempotent.
  if (config.billing.enabled) {
    const { reconcilePendingBillingSubscriptions } = await import('./services/billing-provision.js');
    void reconcilePendingBillingSubscriptions().catch((err) => {
      logger.error('Billing reconcile (boot drain) failed (service will still come ready)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const intervalMs = config.billing.reconcileIntervalMs;
    if (intervalMs > 0) {
      setInterval(() => {
        void reconcilePendingBillingSubscriptions().catch((err) => {
          logger.error('Billing reconcile (interval) failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, intervalMs).unref(); // unref'd so the timer never keeps the process alive
    }
  }

  // Install the per-org KMS provider if SECRET_ENCRYPTION_PER_ORG_KMS=true.
  // Must run AFTER Mongo connects (resolver reads Organization docs) and BEFORE
  // the service goes ready (the guard then lets secret-touching requests
  // through). Fail-closed: a misconfig must not silently fall back to the
  // shared master — abort so the operator sees it immediately.
  const { bootstrapPerOrgKmsProvider } = await import('./services/per-org-kms-bootstrap.js');
  try {
    bootstrapPerOrgKmsProvider();
  } catch (err) {
    logger.error('Per-org KMS provider bootstrap failed; aborting startup', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Seed default dashboards into Postgres (idempotent, fire-and-forget).
  const { seedDefaultDashboards } = await import('./services/dashboard-seeder.js');
  void seedDefaultDashboards();

  // Start the invitation reaper: periodically flips stale `pending` invites
  // (past their `expiresAt`) to `expired` so the data self-heals. Runs an
  // immediate sweep now that Mongo is connected. Non-fatal — the sweep swallows
  // its own errors, and the capacity/roster queries already exclude stale rows
  // regardless. Started here (after connect) rather than at module top so the
  // first sweep isn't a guaranteed miss against a cold datastore.
  const { startInvitationReaper } = await import('./services/invitation-reaper.js');
  startInvitationReaper();

  // Start the org purge sweep: periodically hard-deletes (via the existing
  // fail-closed cascade) any org whose SOFT-DELETE retention window has lapsed
  // (`purgeAfter <= now`). Immediate first sweep now that Mongo is connected;
  // unref'd interval. Non-fatal — the sweep swallows its own errors per org and
  // is idempotent, so a deferred/failed org retries next tick. Coexists with the
  // invitation reaper + billing reconcile wirings above.
  const { startOrgPurgeSweep } = await import('./services/org-purge.js');
  startOrgPurgeSweep();

  setReady(true);
  logger.info('Platform ready — dependencies connected');

  // Keep readiness in sync with Mongo for the life of the process so a later
  // outage drains traffic (NotReady) and a recovery restores it — no restart.
  for (;;) {
    await sleep(READINESS_MONITOR_INTERVAL_MS);
    const ok = mongoose.connection.readyState === 1;
    if (ok && !isReady()) {
      setReady(true);
      logger.info('Platform ready — MongoDB reconnected');
    } else if (!ok && isReady()) {
      setReady(false);
      logger.warn('Platform degraded — MongoDB disconnected (now NotReady)');
    }
  }
}

/**
 * Start the HTTP server, then establish dependencies in the background.
 * Listens FIRST so /health, /ready and the readiness guard respond
 * immediately; a cold Mongo no longer crash-loops the process.
 */
async function startServer(): Promise<void> {
  logger.info('Starting platform microservice...');

  // Configure Mongoose + connection event handlers.
  mongoose.set('strictQuery', true);
  mongoose.connection.on('error', (err) => logger.error('MongoDB connection error:', err));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  // Last-resort fault handlers (uncaught exception / unhandled rejection).
  installCrashHandlers(logger);

  // Mark NotReady before the port opens so the guard rejects business traffic
  // until dependencies connect.
  setReady(false);

  // Start HTTP server (before connecting Mongo).
  const server = app.listen(config.app.port, () => {
    logger.info(`Platform microservice listening on port: ${config.app.port}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully...`);

    server.close(async () => {
      logger.info('HTTP server closed');

      // Stop the invitation reaper + org purge sweep intervals before tearing
      // down Mongo.
      const { stopInvitationReaper } = await import('./services/invitation-reaper.js');
      stopInvitationReaper();
      const { stopOrgPurgeSweep } = await import('./services/org-purge.js');
      stopOrgPurgeSweep();

      try {
        await mongoose.connection.close(false);
        logger.info('MongoDB connection closed');
      } catch (error) {
        logger.error('Error closing MongoDB:', error);
      }

      process.exit(0);
    });

    // Force shutdown after timeout (unref'd so it never itself keeps the
    // process alive, matching api-server's startServer).
    const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '15000', 10);
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, shutdownTimeoutMs).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Establish Mongo + bootstraps in the background; readiness flips when done.
  void initDependencies();
}

// Start
startServer().catch((error) => {
  logger.error('Unhandled error during startup:', error);
  process.exit(1);
});