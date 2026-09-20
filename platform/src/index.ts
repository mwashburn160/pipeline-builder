// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { JWKS_PATH, createHealthRouter, createLogger, installCrashHandlers, mongoSanitize, resolveRedisConnection, sendError, verifyServicePrincipal, errorMessage, retryForever } from '@pipeline-builder/api-core';
import { withTenantContext, readinessGuard, setReady, isReady, mongoHealthCheck, registerSecretRotationGauge } from '@pipeline-builder/api-server';
import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

import { config } from './config/index.js';
import { SCIM_RATE_LIMIT_MAX, SCIM_RATE_LIMIT_WINDOW_MS } from './constants/scim.js';
import { notFoundHandler, errorHandler } from './middleware/index.js';
import { extractClientIp, rateLimitKey, peekJwtClaims, scimOrgKey, verifiedIsSuperAdmin, tierLimitedMax } from './middleware/rate-limit-keys.js';
import { createLimiter } from './middleware/rate-limiter.js';
import {
  isWriteBlockedByImpersonation,
  IMPERSONATION_READ_ONLY_MESSAGE,
  IMPERSONATION_READ_ONLY_CODE,
} from './middleware/require-write-access.js';
import jwksRoutes from './routes/jwks.js';
import { ALERT_WEBHOOK_PATH, SCIM_PATH, mountApiRoutes } from './routes/mount.js';

const logger = createLogger('platform-api');

// Refuse to start on an unusable Redis configuration (throws RedisConfigError)
// rather than running with Redis-backed guarantees quietly switched off.
resolveRedisConnection();

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
// Rotation visibility: `secret_rotation_previous_set{secret}` is 1 while a
// credential's overlap is still open. Platform registers the ones only it holds
// (the ES256 user-token signing key's retiring `kid`, the at-rest master key,
// the relay bearer) on top of api-core's SERVICE_SIGNING_KEY probe. The alert rules page
// on a value that stays 1 — see docs/runbooks/secret-rotation.md.
registerSecretRotationGauge(metricsRegistry);
const { registerPlatformSecretRotationProbes } = await import('./observability/secret-rotation.js');
registerPlatformSecretRotationProbes();
const { startPlatformMetricsScraper, stopPlatformMetricsScraper } = await import('./observability/scraper.js');
startPlatformMetricsScraper();
// (stopped in the unified shutdown() below, alongside the other sweeps — not via
// a separate SIGTERM handler, so SIGINT also tears it down.)

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

/**
 * The Alertmanager relay webhook. Machine-to-machine, and unauthenticated at
 * middleware time (it checks a per-instance bearer inside the handler), so
 * without this exemption it lands in the ANONYMOUS bucket of the user-sized
 * limiters and an alert storm gets 429'd — which Alertmanager treats as a
 * failed notification, silently delaying alerts. It gets `alertWebhookLimiter`
 * instead, sized for burst fan-out. (The path itself is declared next to the
 * mount that uses it — `routes/mount.ts`.)
 */
function isAlertWebhook(req: Request): boolean {
  return req.method === 'POST' && req.path === ALERT_WEBHOOK_PATH;
}

/**
 * The device-authorization poll. RFC 8628 has the waiting client poll every few
 * seconds until the person approves in a browser — ~120 requests over one
 * sign-in, against a general bucket of 100 per 15 minutes for an anonymous
 * caller. It has its own per-device-code and per-IP limiters on the router
 * (`routes/device-auth.ts`), which is where the abuse ceiling belongs; counting
 * it here would 429 every legitimate CLI login halfway through.
 */
function isDevicePoll(req: Request): boolean {
  return req.method === 'POST' && req.path === '/auth/device/token';
}

/**
 * The SCIM surface (3b). An identity provider's initial import is a burst of
 * hundreds of requests, all from one org — against a general bucket sized for a
 * person's interactive use. It has its own per-org bucket (`scimLimiter`), so a
 * directory sync can neither be throttled by, nor starve, the org's people.
 */
function isScim(req: Request): boolean {
  return req.path.startsWith(SCIM_PATH);
}

/** Generous, dedicated bucket for the alert relay — see `isAlertWebhook`. */
const alertWebhookLimiter = createLimiter({
  name: 'alert-webhook',
  windowMs: config.rateLimit.alertWebhook.windowMs,
  max: config.rateLimit.alertWebhook.max,
  keyGenerator: extractClientIp,
  message: 'Alert webhook rate limit exceeded.',
});

/** General rate limiter — per-tier max, keyed by org (or IP for anon callers). */
const limiter = createLimiter({
  name: 'general',
  windowMs: config.rateLimit.windowMs,
  max: tierLimitedMax,
  keyGenerator: rateLimitKey,
  // Sysadmins are internal operators who legitimately make burst calls
  // (audit replays, fleet-wide scans). Bypass the limiter rather than size it
  // for the worst case. The alert relay has its own generous bucket; it must
  // not share the anonymous user budget. The sysadmin check VERIFIES the token:
  // the bypass removes throttling entirely, so a forged `isSuperAdmin:true`
  // must not grant it. `requireAuth` still authorizes the request later.
  skip: (req: Request) => isAlertWebhook(req) || isDevicePoll(req) || isScim(req) || verifiedIsSuperAdmin(req),
  message: 'Too many requests. Please try again later.',
});

/** Strict rate limiter for auth endpoints (login, register, OAuth) — IP-based since the user is not yet authenticated. */
const authLimiter = createLimiter({
  name: 'auth',
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  keyGenerator: extractClientIp,
  // A verified internal service (image-registry relaying `docker login`) sends
  // every user's attempt from one pod IP; counting those in one IP bucket would
  // let one user's failures lock everyone out. That service limits per client
  // and username itself (image-registry token-rate-limiter).
  skip: (req: Request) => verifyServicePrincipal(req),
  message: 'Too many authentication attempts. Please try again later.',
});

/**
 * Per-org rate limiter for observability endpoints. Tighter than the general
 * limiter because every request fans out to Prometheus, and a noisy tenant can
 * degrade that upstream for everyone else (dashboards across all orgs go blank).
 * Keys by the verified token's org when present, falls back to IP.
 */
const observabilityLimiter = createLimiter({
  name: 'observability',
  windowMs: config.rateLimit.observability.windowMs,
  max: config.rateLimit.observability.max,
  keyGenerator: rateLimitKey,
  // The alert relay is mounted under /observability but is not a tenant
  // dashboard query — it has its own bucket (see `isAlertWebhook`).
  skip: isAlertWebhook,
  message: 'Observability rate limit exceeded for your organization. Please slow down or batch your queries.',
});

/**
 * Per-ORG limiter for SCIM (3b). Keyed by the VERIFIED token's org — never the
 * service account — because the plan's requirement is a per-ORG ceiling: a tenant
 * that issues five SCIM keys still gets one directory-sync budget. Falls back to
 * the credential hash / client IP for a request whose token doesn't verify (which
 * `requireScimScope` then refuses anyway).
 */
const scimLimiter = createLimiter({
  name: 'scim',
  windowMs: SCIM_RATE_LIMIT_WINDOW_MS,
  max: SCIM_RATE_LIMIT_MAX,
  keyGenerator: scimOrgKey,
  message: 'SCIM rate limit exceeded for your organization. Slow the provisioning job down and retry.',
});

/**
 * Interval sweeps started INLINE below (rather than in a service module with its
 * own `stopX()`), collected so the unified `shutdown()` can stop them alongside
 * the others.
 *
 * They are `.unref()`'d, so they never keep the process alive — but `.unref()`
 * does not stop them FIRING during a graceful teardown, and a pass that begins
 * after `mongoose.connection.close()` just throws against a closed connection.
 */
const backgroundSweeps: NodeJS.Timeout[] = [];

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

// Health + readiness, standardized on the shared router (replacing platform's
// bespoke /health): GET /health = liveness (200 while the process answers),
// GET /ready = readiness (503 while Mongo is disconnected). Mounted before the
// tenant/auth/rate-limit chain so probes are never gated or throttled.
app.use(createHealthRouter({
  serviceName: 'platform',
  checkDependencies: mongoHealthCheck(mongoose.connection),
}));

// The public key set every verifier in the fleet (and the CLI, image-registry's
// auth resolver and the events Lambda) checks user tokens against. Mounted here,
// beside the probes and AHEAD of the readiness guard, for the reasons documented
// in routes/jwks.ts.
app.use(jwksRoutes);

// Readiness guard — 503s business routes until Mongo connects (and the
// post-connect bootstraps finish). Critically preserves the "per-org KMS
// installed before any secret is served" invariant: `ready` is only set true
// after that bootstrap, so no secret-touching request is served before it.
//
// Narrow allowlist (NOT the shared default): the default bypass list includes
// `/logs` for api-server's SSE log relay, which platform does not have.
app.use(readinessGuard(['/health', '/ready', '/metrics', JWKS_PATH]));

/**
 * Tenant-context middleware (RLS enforcement).
 *
 * Runs before any route handler so the JWT-claimed `organizationId` + role
 * are available in AsyncLocalStorage for every downstream `withTenantTx`
 * call. Same JWT-peek pattern as `peekJwtClaims` — we read the unverified
 * payload here because
 * 1. The signature gets checked later in `requireAuth` (route-level).
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
  if (req.path === '/metrics' || req.path === '/health' || req.path === '/ready' || req.path === JWKS_PATH) {
    next();
    return;
  }
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    // A matched route gives a bounded pattern (`/organization/:id`). An
    // UNMATCHED path (404s, and anything rejected before routing) is
    // caller-controlled, so it collapses to a single label: prom-client
    // counters never expire, so labelling it verbatim let an
    // unauthenticated loop grow `http_requests_total` without bound. The
    // individual paths are still in the request log, where cardinality is free.
    const route = req.route?.path ? req.baseUrl + req.route.path : 'unmatched';
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
 * API Routes (see `routes/mount.ts` — shared with the route-coverage test so the
 * table it checks is exactly what this process serves).
 */
mountApiRoutes(app, { auth: authLimiter, alertWebhook: alertWebhookLimiter, observability: observabilityLimiter, scim: scimLimiter });

/** Error handling middleware (must be registered last) */
app.use(notFoundHandler);
app.use(errorHandler);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MONGO_RETRY_BASE_MS = 1000;
const MONGO_RETRY_MAX_MS = 10000;

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
  const { maxPoolSize, minPoolSize, serverSelectionTimeoutMs: serverSelectionTimeoutMS } = config.mongodb;

  await retryForever(
    () => mongoose.connect(config.mongodb.uri, { maxPoolSize, minPoolSize, serverSelectionTimeoutMS }),
    {
      baseMs: MONGO_RETRY_BASE_MS,
      maxMs: MONGO_RETRY_MAX_MS,
      onAttemptFailed: (err, delayMs) => logger.warn(`MongoDB connect failed, retrying in ${delayMs}ms`, {
        error: errorMessage(err),
      }),
    },
  );
  logger.info('MongoDB connection established', { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });

  // Register the process-wide authorization-denial auditor. Platform gates its
  // state-changing routes with api-core's shared `requirePermission`, which
  // forwards every DENIED (non-GET) request to this sink. We persist each as an
  // `authz.denied` failure event so probing/privilege-escalation attempts leave
  // a trail. Best-effort by contract: the sink must never throw or block the
  // auth gate (the gate wraps the call in try/catch, and the write is
  // fire-and-forget with its own catch). Registered after Mongo connects so the
  // AuditEvent write has a live connection; requests are 503'd until ready.
  const { setAuthzDenialAuditor } = await import('@pipeline-builder/api-core');
  const { auditService } = await import('./services/index.js');
  setAuthzDenialAuditor((info) => {
    void auditService.createEvent({
      action: 'authz.denied',
      actorId: info.actorId ?? 'anonymous',
      actorEmail: info.actorEmail,
      orgId: info.orgId,
      affectedOrgId: info.orgId,
      outcome: 'failure',
      details: { method: info.method, path: info.path, required: info.required },
    }).catch((err) => {
      logger.warn('Failed to persist authz.denied audit event', {
        error: errorMessage(err),
      });
    });
  });

  // Bootstrap super-admins from BOOTSTRAP_SUPERADMIN_EMAILS (idempotent,
  // non-fatal — warns rather than fails on missing accounts).
  const { bootstrapSuperAdmins } = await import('./services/superadmin-bootstrap.js');
  try {
    await bootstrapSuperAdmins();
  } catch (err) {
    logger.error('Super-admin bootstrap failed (service will still come ready)', {
      error: errorMessage(err),
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
      error: errorMessage(err),
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
    const { runWithLeaderLock } = await import('./utils/leader-lock.js');
    void reconcilePendingBillingSubscriptions().catch((err) => {
      logger.error('Billing reconcile (boot drain) failed (service will still come ready)', {
        error: errorMessage(err),
      });
    });
    const intervalMs = config.billing.reconcileIntervalMs;
    if (intervalMs > 0) {
      // Cross-pod leader lock so only ONE replica runs the reconcile pass per
      // window (otherwise every replica scans + provisions the same pending
      // orgs in parallel). TTL floored to comfortably exceed one pass.
      const lockTtlMs = Math.max(intervalMs, 60_000);
      backgroundSweeps.push(setInterval(() => {
        void runWithLeaderLock('platform:leader:billing-reconcile', lockTtlMs, async () => {
          await reconcilePendingBillingSubscriptions();
        });
      }, intervalMs).unref());
    }
  }

  // Periodic re-verification of domain-based-join domains (P2b): re-checks the
  // DNS TXT proof for domains not verified recently and un-verifies any whose
  // record is definitively gone (owner removed it / domain transferred), so a
  // stale domain can't keep admitting signups forever. Leader-locked (one
  // replica per window); intervals env-tunable, defaults 24h sweep / 7d staleness.
  {
    const { domainReverifyIntervalMs: reverifyIntervalMs, domainReverifyStaleMs: reverifyStaleMs } = config.organization;
    if (reverifyIntervalMs > 0) {
      const { runWithLeaderLock } = await import('./utils/leader-lock.js');
      const lockTtlMs = Math.max(reverifyIntervalMs, 60_000);
      backgroundSweeps.push(setInterval(() => {
        void runWithLeaderLock('platform:leader:domain-reverify', lockTtlMs, async () => {
          const { orgDomainService } = await import('./services/org-domain-service.js');
          const res = await orgDomainService.reverifyStaleDomains(reverifyStaleMs);
          if (res.checked > 0) logger.info('Domain re-verification sweep', res);
        });
      }, reverifyIntervalMs).unref());
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
      error: errorMessage(err),
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

  // Same for impersonation requests: flip ones whose window lapsed unused to
  // `expired`, so their status stays truthful (see impersonation-reaper.ts).
  const { startImpersonationReaper } = await import('./services/impersonation-reaper.js');
  startImpersonationReaper();

  // Start the org purge sweep: periodically hard-deletes (via the existing
  // fail-closed cascade) any org whose SOFT-DELETE retention window has lapsed
  // (`purgeAfter <= now`). Immediate first sweep now that Mongo is connected;
  // unref'd interval. Non-fatal — the sweep swallows its own errors per org and
  // is idempotent, so a deferred/failed org retries next tick. Coexists with the
  // invitation reaper + billing reconcile wirings above.
  const { startOrgPurgeSweep } = await import('./services/org-purge.js');
  startOrgPurgeSweep();

  // Retention purge for platform-owned soft-deleted tables (dashboards + alerts).
  // Leader-locked + sysadmin-scoped inside the sweep. Opt out via SOFT_DELETE_PURGE_ENABLED=false.
  const { startSoftDeletePurge } = await import('./services/soft-delete-purge.js');
  startSoftDeletePurge();

  setReady(true);
  logger.info('Platform ready — dependencies connected');

  // Keep readiness in sync with Mongo for the life of the process so a later
  // outage drains traffic (NotReady) and a recovery restores it — no restart.
  for (;;) {
    await sleep(config.server.readinessMonitorIntervalMs);
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

  // Load the ES256 user-token signing keys BEFORE the port opens. Platform is
  // the only minter in the fleet, so a key it cannot load is not a degraded
  // mode — nobody could sign in, and /.well-known/jwks.json would serve nothing
  // for anyone else to verify against. Fail the startup instead (the catch on
  // `startServer()` exits non-zero).
  const { initTokenSigning } = await import('./services/token-signing/index.js');
  await initTokenSigning();

  // Same rule for the INTERNAL chain (#14): platform signs its own peer calls
  // with its own key and verifies its peers against the public bundle. Without
  // them it would mint tokens on an EPHEMERAL in-process key that no peer
  // accepts, and reject every peer's token — silently losing all
  // service-to-service traffic rather than failing loudly.
  for (const envVar of ['SERVICE_SIGNING_KEY_FILE', 'SERVICE_KEY_BUNDLE_FILE'] as const) {
    if (!process.env[envVar]) {
      throw new Error(`${envVar} environment variable is required (generate with deploy/bin/service-signing-keys.sh). Set it before starting platform.`);
    }
  }

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
      const { stopImpersonationReaper } = await import('./services/impersonation-reaper.js');
      stopImpersonationReaper();
      const { stopOrgPurgeSweep } = await import('./services/org-purge.js');
      stopOrgPurgeSweep();
      const { stopSoftDeletePurge } = await import('./services/soft-delete-purge.js');
      stopSoftDeletePurge();
      stopPlatformMetricsScraper();
      // The sweeps started inline in this file (billing reconcile, domain
      // re-verify) — see `backgroundSweeps`. Stopped BEFORE Mongo closes.
      for (const timer of backgroundSweeps) clearInterval(timer);

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
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, config.server.shutdownTimeoutMs).unref();
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