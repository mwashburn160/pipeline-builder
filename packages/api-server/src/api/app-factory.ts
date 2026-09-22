// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, generateOpenApiSpec, ErrorCode, createLogger, verifyServicePrincipal, createHealthRouter, setCounterEmitter, requireAuth, safeEqual, createEnvSseTicketStore, SSE_TICKET_TTL_MS } from '@pipeline-builder/api-core';
import type { OpenApiSpecOptions } from '@pipeline-builder/api-core';
import { Config, CoreConstants } from '@pipeline-builder/pipeline-core';
import { getConnection } from '@pipeline-builder/pipeline-data';
import compression from 'compression';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { v7 as uuid } from 'uuid';
import { etagMiddleware } from './etag-middleware.js';
import { createEnvRedisIdempotencyStore, setIdempotencyStore, type IdempotencyStore } from './idempotency-middleware.js';
import { metricsMiddleware, metricsHandler, incCounter } from './metrics.js';
import { createSharedRateLimitStore } from './rate-limit-store.js';
import { readinessGuard } from './readiness.js';
import { SSEManager, SSE_REQUEST_ID_RE } from '../http/sse-connection-manager.js';
import { createEnvRedisSSERelay } from '../http/sse-relay.js';

// Wire api-core's counter shim to the real prom-client registry. This is
// a no-op until incCounter is called for the first time (lazy registration
// in metrics.ts), and lets api-core helpers like the quota client record
// `quota_fail_open_total` without taking a hard dep on api-server.
setCounterEmitter(incCounter);

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
  /**
   * Path prefixes the global JSON body parser must NOT touch — for routes that need
   * the raw body (e.g. a Stripe webhook whose HMAC is computed over the exact bytes).
   * Without this the global parser consumes the body first and a later `express.raw()`
   * on the same path is a no-op, breaking signature verification.
   */
  jsonBodyExclude?: string[];
  /** Enable URL-encoded body parsing (default: true) */
  enableUrlEncoded?: boolean;
  /** URL-encoded body size limit (default: '1mb') */
  urlEncodedLimit?: string;
  /** Custom SSE manager instance */
  sseManager?: SSEManager;
  /**
   * Serve the per-request build-log stream: `POST /logs/ticket` +
   * `GET /logs/:requestId`, a log ticket store, the cross-pod relay, and
   * `ctx.log` frames pushed to SSE. Default false — a service without it has no
   * `/logs` routes and `ctx.log` only writes to the logger.
   */
  logStream?: boolean;
  /** Health check dependency checker — if provided, /health reports dependency status */
  checkDependencies?: () => Promise<Record<string, 'connected' | 'disconnected' | 'unknown'>>;
  /**
   * Serve the OpenAPI spec at `/docs/openapi.json` and Swagger UI at `/docs`.
   *
   * Defaults to OFF under `NODE_ENV=production`: the routes are registered above
   * the rate limiter and are not auth-gated, so in production they would publish
   * the full route + schema inventory of every service to anyone who could reach
   * the port. Pass `true` explicitly to serve them in production anyway.
   */
  enableOpenApi?: boolean;
  /** OpenAPI spec customization options */
  openApiOptions?: OpenApiSpecOptions;
  /** Enable gzip/deflate response compression (default: true) */
  enableCompression?: boolean;
  /**
   * Idempotency replay-cache backend for keyed mutation retries. When omitted,
   * createApp auto-wires the shared env Redis store (multi-replica dedup) if
   * Redis is configured, else keeps the in-memory default (single-replica).
   * Pass an explicit store to inject a bespoke backend (e.g. a service's own
   * ioredis connection).
   */
  idempotencyStore?: IdempotencyStore;
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

/** Helmet (strict CSP), CORS, compression and ETags. */
function applySecurityHeaders(app: Express, options: CreateAppOptions, enableOpenApi: boolean): void {
  const { enableCors = true, enableHelmet = true, enableCompression = true } = options;
  // Swagger UI needs unsafe-inline + unsafe-eval for its bundled scripts —
  // but CSP is only relaxed that far when (a) OpenAPI is enabled AND (b) we're
  // not in production. In prod, Swagger should be served behind a separate
  // host or auth-gated route; the main app keeps the strict CSP so a Stored
  // XSS in any handler can't `eval()` arbitrary script.
  const allowSwaggerCsp = enableOpenApi && process.env.NODE_ENV !== 'production';
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
    app.use(cors(Config.get('server').cors));
  }

  // Response compression (gzip/deflate) — skip SSE streams
  if (enableCompression) {
    app.use(compression({
      filter: (req: Request, res: Response) => {
        // Don't compress SSE streams. Match by inclusion: the Accept header is
        // often a list (e.g. "text/event-stream, */*"), which exact equality
        // would miss, compressing/buffering the stream.
        if ((req.headers.accept || '').includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
      threshold: CoreConstants.COMPRESSION_THRESHOLD_BYTES,
    }));
  }

  // ETag support for conditional GET requests (304 Not Modified)
  app.use(etagMiddleware());
}

/** JSON + URL-encoded body parsers. */
function applyBodyParsing(app: Express, options: CreateAppOptions): void {
  const { enableJsonBody = true, jsonLimit = '1mb', enableUrlEncoded = true, urlEncodedLimit = '1mb' } = options;
  if (enableJsonBody) {
    const jsonParser = express.json({ limit: jsonLimit });
    const exclude = options.jsonBodyExclude ?? [];
    if (exclude.length > 0) {
      // Skip the global JSON parser for raw-body paths so a per-path `express.raw()`
      // can read the exact bytes (see `jsonBodyExclude`).
      app.use((req, res, next) => (exclude.some((p) => req.path.startsWith(p)) ? next() : jsonParser(req, res, next)));
    } else {
      app.use(jsonParser);
    }
  }

  if (enableUrlEncoded) {
    app.use(express.urlencoded({ extended: true, limit: urlEncodedLimit }));
  }
}

/**
 * Health, readiness guard, `/warmup`, `/metrics` and the OpenAPI docs — all
 * registered before the rate limiter so they are never throttled.
 */
function mountInfraEndpoints(app: Express, options: CreateAppOptions, serviceName: string, enableOpenApi: boolean): void {
  const { checkDependencies, openApiOptions, warmupHooks = [] } = options;

  app.use(createHealthRouter({
    serviceName,
    checkDependencies,
  }));

  // Readiness guard — 503s business traffic while the service is NotReady
  // (datastore still connecting at startup, or dropped). Mounted right after
  // the health router and before everything else so a NotReady request is
  // rejected cheaply, before rate-limit / idempotency / business handlers ever
  // touch a disconnected datastore. It allowlists the infra endpoints
  // (/metrics, /warmup, /docs, /logs) registered below, plus /health + /ready.
  app.use(readinessGuard());

  // Warm-up endpoint — pre-opens connection pools so the first real request
  // doesn't pay cold-start latency. Always pings Postgres; services using
  // Mongo / Redis / SQS pass `warmupHooks` so those are warmed in parallel.
  //
  // GATED to verified service principals. Every hit runs a Postgres round-trip
  // plus all `warmupHooks` (Mongo/Redis/SQS), so an open endpoint would let an
  // anonymous loop amplify into datastore load on every service in the fleet —
  // and it is registered above the rate limiter, so nothing would throttle it.
  // `verifyServicePrincipal` checks the bearer token cryptographically, so it is
  // safe here, above `requireAuth`.
  app.get('/warmup', async (req: Request, res: Response) => {
    if (!verifyServicePrincipal(req)) {
      sendError(res, 404, 'Not found');
      return;
    }
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

  // Prometheus metrics endpoint — always registered (never throttled).
  //
  // Optionally gated: when `METRICS_SCRAPE_TOKEN` is set, the scraper must send
  // it as a bearer token (Prometheus `bearer_token` / `bearer_token_file` in the
  // scrape config). Left ungated when unset so enabling it is a deliberate,
  // coordinated change rather than a silent monitoring outage — tenant ids stay
  // out of the output regardless, because the per-org label defaults OFF (see
  // HTTP_METRICS_ORG_SAMPLE_RATE in metrics.ts).
  const metricsToken = process.env.METRICS_SCRAPE_TOKEN;
  app.get('/metrics', (req: Request, res: Response, next: NextFunction) => {
    if (!metricsToken) {
      next();
      return;
    }
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    // Constant-time compare — a length-independent equality check here would
    // leak the token a byte at a time.
    if (!presented || !safeEqual(presented, metricsToken)) {
      sendError(res, 404, 'Not found');
      return;
    }
    next();
  }, metricsHandler());

  if (enableOpenApi) {
    const spec = generateOpenApiSpec(openApiOptions);
    app.get('/docs/openapi.json', (_req: Request, res: Response) => {
      res.json(spec);
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, {
      customSiteTitle: openApiOptions?.title ?? 'Pipeline Builder API Docs',
    }));
  }
}

/** Global rate limiter — shared across replicas via the env Redis when configured. */
function mountRateLimiter(app: Express, serviceName: string): void {
  const rateLimitConfig = Config.get('rateLimit');

  const rateLimitOptions: Parameters<typeof rateLimit>[0] = {
    max: rateLimitConfig.max,
    windowMs: rateLimitConfig.windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting only for CRYPTOGRAPHICALLY-VERIFIED internal service
    // callers. The limiter runs before requireAuth, so a plaintext header
    // would be spoofable by any external client → total bypass.
    // verifyServicePrincipal verifies the signed service JWT instead;
    // inter-service callers all send one (getServiceAuthHeader).
    skip: (req: Request) => verifyServicePrincipal(req),
    // Key on client IP only. The limiter runs pre-auth, so `req.user` is unset
    // and any org id would come from the caller-supplied `x-org-id` header —
    // spoofable, letting an attacker rotate values to evade the bucket or
    // flood a victim org's bucket. ipKeyGenerator normalizes IPv6 to a /64
    // prefix (also required by express-rate-limit 8.x's validator).
    keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'anon', 64),
    // A store failure (Redis down / failing over) must degrade to "not rate
    // limited", never to a 500 on every request of every service.
    passOnStoreError: true,
    handler: (_req: Request, res: Response) => {
      sendError(res, 429, 'Too many requests, please try again later.', ErrorCode.RATE_LIMIT_EXCEEDED);
    },
    // Shared state across replicas (the process-wide rate-limit Redis connection;
    // undefined without Redis → per-process memory store, right for one replica).
    // Namespaced per SERVICE: every service shares one Redis, and an unprefixed
    // `rl:<ip>` key would let one client's traffic to ANY service drain its
    // budget on EVERY service.
    store: createSharedRateLimitStore(`${serviceName}:global`),
  };

  app.use(rateLimit(rateLimitOptions));
}

/** Request timeout, duration logging and HTTP metrics. */
function applyRequestTelemetry(app: Express): void {
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
      // Log `req.path` (no query string) — a stray `?token=`/`?ticket=` must not be
      // persisted verbatim on every request (mirrors the authz-denial auditor's strip).
      durationLogger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: duration,
        requestId: req.requestId,
      });
    });
    next();
  });

  // Prometheus metrics middleware — records request duration and count
  app.use(metricsMiddleware());
}

/**
 * The default SSE manager. The relay (this service's own Redis channel) is
 * built only when something streams: the log stream turns it on here, and an
 * org-keyed channel turns it on when registered (registerSseTicketChannel).
 * The log ticket store exists only with the log stream.
 */
function createDefaultSseManager(serviceName: string, logStream: boolean): SSEManager {
  const sseManager = new SSEManager({
    logStream,
    relayFactory: () => createEnvRedisSSERelay(serviceName),
    ...(logStream && {
      ticketStore: createEnvSseTicketStore({
        ttlMs: SSE_TICKET_TTL_MS,
        keyPrefix: `logs:${serviceName}`,
      }),
    }),
  });
  if (logStream) sseManager.enableRelay();
  return sseManager;
}

/**
 * The per-request build-log stream: `POST /logs/ticket` + `GET /logs/:requestId`.
 *
 * Ticket-gated — the stream carries per-org build logs, so it must not be
 * world-readable. Clients first POST /logs/ticket (JWT-authenticated) to mint a
 * short-lived, single-use ticket bound to their org AND to the specific
 * `requestId` stream they intend to open, then open the EventSource with
 * ?ticket=<t>. This keeps the JWT out of query strings / access logs while
 * enforcing org ownership, per-subject authorization, and the per-org
 * connection cap on the stream. Mirrors the message-service notifications SSE
 * ticket exchange.
 */
function wireSse(app: Express, sseManager: SSEManager): void {
  app.post('/logs/ticket', requireAuth, async (req: Request, res: Response) => {
    const orgId = req.user?.organizationId?.toLowerCase();
    if (!orgId) {
      sendError(res, 400, 'Token missing organization', ErrorCode.VALIDATION_ERROR);
      return;
    }
    // The caller must name the stream subject up front so the ticket is bound to
    // it. Without this, a ticket could be replayed against ANY requestId the
    // org could guess, letting it attach to another org's log stream. Strictly
    // format-validated so it can't carry an injection payload into the subject.
    const requestId = (req.body as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== 'string' || !SSE_REQUEST_ID_RE.test(requestId)) {
      sendError(res, 400, 'Missing or invalid requestId', ErrorCode.VALIDATION_ERROR);
      return;
    }
    const result = await sseManager.createTicket(orgId, requestId);
    if (!result.ok) {
      if (result.reason === 'forbidden') {
        // The subject is owned by another org — do not confirm it exists; a plain
        // 403 is enough and leaks nothing about which requestIds are live.
        sendError(res, 403, 'Not authorized for this log stream', ErrorCode.INSUFFICIENT_PERMISSIONS);
      } else if (result.reason === 'org-limit') {
        sendError(res, 429, 'Too many log stream tickets issued', ErrorCode.QUOTA_EXCEEDED);
      } else {
        sendError(res, 503, 'Log streaming subsystem at capacity', ErrorCode.QUOTA_EXCEEDED);
      }
      return;
    }
    sendSuccess(res, 200, { ticket: result.ticket });
  });

  // The stream itself resolves + consumes the ticket inside middleware() and
  // rejects any anonymous / invalid / expired / already-used ticket with 401.
  app.get('/logs/:requestId', sseManager.middleware());
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
 * - SSE logs endpoint (/logs/:requestId) — only with `logStream: true`
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
    enableRateLimit = true,
    logStream = false,
    enableOpenApi = process.env.NODE_ENV !== 'production',
  } = options;

  const serviceName = process.env.SERVICE_NAME || 'api';

  // A caller-supplied `sseManager` skips the default construction entirely.
  const sseManager = options.sseManager ?? createDefaultSseManager(serviceName, logStream);

  // Wire the idempotency replay-cache backend used by the post-auth route
  // factories (createProtectedRoute / createAuthenticatedWithOrgRoute). Prefer
  // an explicitly injected store; otherwise auto-construct from the shared env
  // Redis so keyed mutation retries dedupe across replicas. Falls back to the
  // in-memory default when no Redis is configured (single-replica correctness).
  const resolvedIdempotencyStore = options.idempotencyStore ?? createEnvRedisIdempotencyStore();
  if (resolvedIdempotencyStore) {
    setIdempotencyStore(resolvedIdempotencyStore);
  }

  // OpenTelemetry is NOT initialized here: by the time createApp runs, express
  // and http have already been required, so the auto-instrumentation hooks
  // would have nothing to patch (no inbound span → no trace id). Tracing is
  // started by the `otel-bootstrap.js` preload instead (node -r … — see each
  // service's Dockerfile CMD / start script), which runs before any
  // instrumented module loads. `currentTraceId()` then reads the active span.

  const app = express();

  applySecurityHeaders(app, options, enableOpenApi);
  applyBodyParsing(app, options);

  // Trust proxy (must be set before rate limiter so req.ip resolves correctly)
  app.set('trust proxy', Config.get('server').trustProxy);

  // Request ID — prefer existing header from nginx, otherwise generate one
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hdr = req.headers['x-request-id'];
    const requestId = (Array.isArray(hdr) ? hdr[0] : hdr) || uuid();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  });

  mountInfraEndpoints(app, options, serviceName, enableOpenApi);
  if (enableRateLimit) mountRateLimiter(app, serviceName);
  applyRequestTelemetry(app);

  // NOTE: idempotency is intentionally NOT mounted here. It needs the VERIFIED
  // org id to namespace its replay cache, but this pre-auth position runs before
  // `requireAuth`/`attachRequestContext` populate identity, so a global mount
  // here is a permanent no-op (org always undefined → skip). It is instead wired
  // into the post-auth route chains — see `createProtectedRoute` /
  // `createAuthenticatedWithOrgRoute` in middleware-factory.ts.

  if (logStream) wireSse(app, sseManager);

  return { app, sseManager };
}
