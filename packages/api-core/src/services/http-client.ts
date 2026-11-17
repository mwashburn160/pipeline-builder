// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';
import * as https from 'https';
import { getCircuitBreaker, circuitBreakerKey, CircuitOpenError } from './circuit-breaker.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RATE_LIMIT_RETRIES,
  getRetryDecision,
  getErrorRetryDecision,
  type RetryConfig,
} from './retry-strategy.js';
import { HttpStatus } from '../constants/http-status.js';
import type { ServiceConfig } from '../types/common.js';
import { sleep } from '../utils/concurrency.js';
import { envInt } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

const logger = createLogger('http-client');

/**
 * Default request timeout in milliseconds (env: `HTTP_CLIENT_TIMEOUT_MS`).
 */
const DEFAULT_TIMEOUT = envInt('HTTP_CLIENT_TIMEOUT_MS', 5000, { min: 1 });

/**
 * Default cap on concurrent keep-alive sockets per client agent
 * (env: `HTTP_CLIENT_MAX_SOCKETS`). Node's default is `Infinity`, which lets a
 * burst of concurrent calls open unbounded sockets against a downstream service
 * (fd exhaustion + connection-storm on the callee). 64 is ample for
 * service-to-service fan-out while staying bounded.
 */
const DEFAULT_MAX_SOCKETS = envInt('HTTP_CLIENT_MAX_SOCKETS', 64, { min: 1 });

/**
 * Default cap on a response body (bytes; env: `HTTP_CLIENT_MAX_RESPONSE_BYTES`,
 * default 10 MiB). Every response is buffered and JSON-parsed in memory, so an
 * unbounded body from a misbehaving (or compromised) peer is a memory DoS on the
 * caller. Exceeding it aborts the request with {@link ResponseTooLargeError}.
 */
const DEFAULT_MAX_RESPONSE_BYTES = envInt('HTTP_CLIENT_MAX_RESPONSE_BYTES', 10 * 1024 * 1024, { min: 1 });

/** A response body exceeded the client's `maxResponseBytes`. Not retried. */
export class ResponseTooLargeError extends Error {
  readonly code = 'RESPONSE_TOO_LARGE';
  constructor(limit: number) {
    super(`Response body exceeded ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * A 2xx/3xx response whose body is not valid JSON. The peer claimed success but
 * sent something the caller cannot read — before, the client quietly returned
 * `{}`, indistinguishable from a real empty object, so callers acted on data
 * that was never sent. Not retried (it is the peer's content, not a transient
 * fault) and not counted against the breaker (the peer answered).
 *
 * An EMPTY body is not this error: it still parses to `{}` (a 204, a bare 200).
 * A 4xx/5xx with an unparseable body (a proxy's HTML error page) does not throw
 * either — the status is the signal there, so retries and status handling keep
 * working; the response carries `bodyInvalid: true` and `body: {}` instead.
 */
export class InvalidResponseBodyError extends Error {
  readonly code = 'INVALID_RESPONSE_BODY';
  constructor(
    readonly statusCode: number,
    readonly headers: http.IncomingHttpHeaders,
    /** The first 512 characters of the body, for diagnostics. */
    readonly bodySnippet: string,
  ) {
    super(`Response body (status ${statusCode}) is not valid JSON`);
    this.name = 'InvalidResponseBodyError';
  }
}

// HTTP methods that are idempotent by definition — safe to auto-retry on a
// 5xx/connection/timeout without risking a duplicate side effect.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * HTTP request options.
 */
export interface RequestOptions {
  /** Request headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Maximum retry attempts for transient failures (default: 2) */
  maxRetries?: number;
  /** Base delay between retries in ms — doubles each attempt (default: 200) */
  retryDelayMs?: number;
  /** Maximum retry attempts specifically for 429 rate limiting (default: 4) */
  maxRateLimitRetries?: number;
  /** Optional request ID for distributed tracing (added as X-Request-Id header) */
  requestId?: string;
  /**
   * Treat this request as safe to auto-retry on 5xx/connection/timeout even
   * though the method is non-idempotent (e.g. the endpoint is idempotent by an
   * Idempotency-Key, or the operation is naturally idempotent). Default false:
   * non-idempotent methods are NOT retried on those failures, only on 429.
   */
  idempotent?: boolean;
  /** Cap on this response's body in bytes (default: the client's, else 10 MiB). */
  maxResponseBytes?: number;
  /**
   * Route class for the circuit breaker (default: the client's, else
   * `'default'`). Requests in different classes to the same `host:port` trip
   * independent breakers — see `circuitBreakerKey`.
   */
  breakerClass?: string;
  /**
   * Cancels the request: aborting it destroys the in-flight request (or cuts a
   * retry back-off short) and rejects with the signal's `reason`, as `fetch`
   * does. An abort is the caller's decision, so it is never retried and never
   * counted against the circuit breaker.
   */
  signal?: AbortSignal;
}

/**
 * Options for a DELETE. The client sends no body on a DELETE, so `body` is a
 * type error here: a body in the options would reach the peer as nothing at
 * all. Put what the peer needs in the path or query string.
 */
export type DeleteRequestOptions = RequestOptions & { body?: never };

/**
 * HTTP client response wrapper.
 */
export interface HttpClientResponse<T = unknown> {
  /** HTTP status code */
  statusCode: number;
  /** Response body (parsed JSON) */
  body: T;
  /** Response headers */
  headers: http.IncomingHttpHeaders;
  /**
   * True when a 4xx/5xx body was not valid JSON (`body` is then `{}`). A 2xx/3xx
   * with such a body rejects with {@link InvalidResponseBodyError} instead.
   * Absent for a parsed (or empty) body.
   */
  bodyInvalid?: true;
}

/**
 * Internal HTTP client for service-to-service communication.
 *
 * @example
 * ```typescript
 * const client = new InternalHttpClient({
 *   host: 'quota',
 *   port: 3000,
 *   timeout: 5000,
 * });
 *
 * const response = await client.get('/org123/apiCalls');
 * const result = await client.post('/org123/increment', { quotaType: 'apiCalls' });
 * ```
 */
/**
 * Options controlling the client's connection pool.
 */
export interface HttpClientOptions {
  /**
   * A caller-owned `http.Agent` to use instead of the process-wide shared one.
   * The client never destroys it.
   */
  agent?: http.Agent;
  /** Cap on concurrent keep-alive sockets for the shared agent (default 64). */
  maxSockets?: number;
  /** Default circuit-breaker route class for this client's requests. */
  breakerClass?: string;
  /** Default response-body cap (bytes) for this client's requests. */
  maxResponseBytes?: number;
}

/**
 * Process-wide keep-alive agents, one per `host:port` (and socket cap) —
 * mirroring the per-target circuit-breaker registry. Clients are cheap and often
 * built per call (an org-hierarchy walk builds one per hop), so a per-client
 * agent threw away its pooled sockets every time and the socket cap bounded
 * nothing. Sharing the agent pools connections to a downstream across every
 * client that targets it.
 */
const sharedAgents = new Map<string, http.Agent>();

function getSharedAgent(protocol: 'http' | 'https', host: string, port: number, maxSockets: number): http.Agent {
  const key = `${protocol}://${host}:${port}:${maxSockets}`;
  let agent = sharedAgents.get(key);
  if (!agent) {
    agent = protocol === 'https'
      ? new https.Agent({ keepAlive: true, maxSockets })
      : new http.Agent({ keepAlive: true, maxSockets });
    sharedAgents.set(key, agent);
  }
  return agent;
}

/**
 * Resolve a {@link ServiceConfig} to scheme + host + port. `host` may be a bare
 * hostname (scheme from `protocol`, default `http`) or a URL —
 * `https://billing.internal:8443` — whose scheme and port win. The scheme picks
 * the transport module (`http` / `https`).
 */
function resolveTarget(config: ServiceConfig): { protocol: 'http' | 'https'; host: string; port: number } {
  if (config.host.includes('://')) {
    const url = new URL(config.host);
    const scheme = url.protocol.replace(/:$/, '');
    if (scheme !== 'http' && scheme !== 'https') throw new Error(`Unsupported service URL scheme: ${url.protocol}`);
    const port = url.port ? Number(url.port) : (config.port ?? (scheme === 'https' ? 443 : 80));
    return { protocol: scheme, host: url.hostname, port };
  }
  return { protocol: config.protocol ?? 'http', host: config.host, port: config.port };
}

/** The reason an aborted signal rejects with — the signal's own `reason`, as `fetch` does. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined ? 'The operation was aborted' : String(reason));
  err.name = 'AbortError';
  return err;
}

/** `sleep` that an abort cuts short (rejecting with the abort reason). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Close every shared keep-alive agent (idle sockets are released; in-flight
 * requests finish). For process shutdown and tests — a later request simply
 * builds a fresh agent.
 */
export function destroySharedHttpAgents(): void {
  for (const agent of sharedAgents.values()) agent.destroy();
  sharedAgents.clear();
}

export class InternalHttpClient {
  private config: { host: string; port: number; timeout: number };
  private protocol: 'http' | 'https';
  private agent: http.Agent;
  private breakerClass?: string;
  private maxResponseBytes: number;

  /**
   * Create a new HTTP client instance.
   *
   * @param config - Service configuration
   * @param options - Optional connection-pool controls (own agent / socket cap)
   */
  constructor(config: ServiceConfig, options?: HttpClientOptions) {
    const target = resolveTarget(config);
    this.protocol = target.protocol;
    this.config = {
      host: target.host,
      port: target.port,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };
    this.agent = options?.agent
      ?? getSharedAgent(this.protocol, this.config.host, this.config.port, options?.maxSockets ?? DEFAULT_MAX_SOCKETS);
    this.breakerClass = options?.breakerClass;
    this.maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /**
   * Make a GET request.
   */
  async get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpClientResponse<T>> {
    return this.requestWithRetry<T>('GET', path, undefined, options);
  }

  /**
   * Make a POST request.
   */
  async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpClientResponse<T>> {
    return this.requestWithRetry<T>('POST', path, body, options);
  }

  /**
   * Make a PUT request.
   */
  async put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpClientResponse<T>> {
    return this.requestWithRetry<T>('PUT', path, body, options);
  }

  /**
   * Make a DELETE request.
   */
  async delete<T = unknown>(path: string, options?: DeleteRequestOptions): Promise<HttpClientResponse<T>> {
    return this.requestWithRetry<T>('DELETE', path, undefined, options);
  }

  /**
   * Request with retry logic for transient failures.
   *
   * - 429 (rate limit): respects `Retry-After` header, uses longer base delay (4x),
   *   retries up to `maxRateLimitRetries` times (default 4).
   * - 502/503/504 (server errors): standard exponential backoff, up to `maxRetries` (default 2).
   * - Connection errors / timeouts: retries up to `maxRetries`.
   * - All delays include ±25% jitter to prevent thundering herd.
   */
  private async requestWithRetry<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpClientResponse<T>> {
    // A malformed path is a CLIENT bug, not a downstream fault — reject it up
    // front so it never burns retries or feeds the circuit breaker (which would
    // otherwise shed traffic to a perfectly healthy downstream). request() keeps
    // the same guard as defence-in-depth.
    if (path.includes('://') || path.startsWith('//') || /[\r\n\0]/.test(path)) {
      throw new Error(`Invalid request path: ${path}`);
    }

    // Already cancelled: nothing to send, nothing for the breaker to learn.
    const signal = options?.signal;
    if (signal?.aborted) throw abortReason(signal);

    const retryConfig: RetryConfig = {
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      maxRateLimitRetries: options?.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES,
      retryDelayMs: options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };
    const totalMaxAttempts = Math.max(retryConfig.maxRetries, retryConfig.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES);

    // Whether it's safe to auto-retry this request on a 5xx/connection/timeout.
    // A timed-out POST may have already been processed server-side, so retrying
    // a non-idempotent request risks a DUPLICATE side effect (double-charge,
    // double-create). Only GET/HEAD/OPTIONS, an explicit `idempotent` opt-in, or
    // a request carrying an Idempotency-Key are auto-retried on those failures.
    // (429 is always retried — see below — since it was rejected, not processed.)
    const retrySafe =
      IDEMPOTENT_METHODS.has(method.toUpperCase()) ||
      options?.idempotent === true ||
      !!(options?.headers && (options.headers['Idempotency-Key'] || options.headers['idempotency-key']));

    // Per-target circuit breaker + S2S request metrics. `target` is the shared
    // breaker/metric key so one bad downstream trips once (not once-per-client)
    // and dashboards can see S2S health per callee.
    const target = `${this.config.host}:${this.config.port}`;
    const breaker = getCircuitBreaker(circuitBreakerKey(target, options?.breakerClass ?? this.breakerClass));
    if (!breaker.allowRequest()) {
      // Fast-fail without touching the network — this is the load-shedding that
      // prevents a downstream brownout from cascading via retry storms.
      emitCounter('s2s_requests_total', { target, method, outcome: 'circuit_open' });
      throw new CircuitOpenError(target);
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= totalMaxAttempts; attempt++) {
      try {
        const response = await this.request<T>(method, path, body, options);

        const decision = getRetryDecision(response.statusCode, response.headers, attempt, retryConfig);
        // 429 is safe to retry for ANY method (rate-limited → not processed); a
        // 5xx/gateway error is only retried when the request is retry-safe.
        if (decision.shouldRetry && (response.statusCode === 429 || retrySafe)) {
          logger.debug(decision.reason + ', retrying', { method, path, attempt: attempt + 1, delayMs: decision.delayMs });
          emitCounter('s2s_request_retries_total', { target, method });
          await abortableSleep(decision.delayMs, signal);
          continue;
        }

        // Terminal response. A 5xx is a downstream fault (feeds the breaker); a
        // 429 is backpressure, not a fault — the service answered, so it counts
        // as success for breaker purposes (never trip the breaker on rate limits).
        const isServerFault = response.statusCode >= 500 && response.statusCode <= 599;
        if (isServerFault) {
          breaker.recordFailure();
          emitCounter('s2s_requests_total', { target, method, outcome: 'server_error' });
        } else {
          breaker.recordSuccess();
          emitCounter('s2s_requests_total', { target, method, outcome: 'success' });
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // The caller cancelled (mid-request or mid-back-off): its decision, not
        // a downstream fault — never retried, never fed to the breaker. A
        // half-open probe it cancelled is released without a verdict.
        if (signal?.aborted) {
          breaker.releaseProbe();
          emitCounter('s2s_requests_total', { target, method, outcome: 'aborted' });
          throw lastError;
        }
        // An oversized or unreadable body is the peer's content, not a transient
        // fault: never re-download it, and never count it against the breaker.
        if (lastError instanceof ResponseTooLargeError || lastError instanceof InvalidResponseBodyError) {
          breaker.recordSuccess();
          emitCounter('s2s_requests_total', {
            target, method, outcome: lastError instanceof ResponseTooLargeError ? 'too_large' : 'invalid_body',
          });
          throw lastError;
        }
        const decision = getErrorRetryDecision(attempt, retryConfig);
        if (decision.shouldRetry && retrySafe) {
          logger.debug('Retrying after error', { method, path, error: lastError.message, attempt: attempt + 1 });
          emitCounter('s2s_request_retries_total', { target, method });
          try {
            await abortableSleep(decision.delayMs, signal);
          } catch (abortErr) {
            breaker.releaseProbe();
            emitCounter('s2s_requests_total', { target, method, outcome: 'aborted' });
            throw abortErr;
          }
          continue;
        }
        // Not retrying (non-idempotent, or attempts exhausted) — a connection
        // error/timeout is a downstream fault: feed the breaker and fail now.
        breaker.recordFailure();
        emitCounter('s2s_requests_total', { target, method, outcome: 'error' });
        throw lastError;
      }
    }

    // Loop exhausted without returning (all attempts retried then ran out).
    breaker.recordFailure();
    emitCounter('s2s_requests_total', { target, method, outcome: 'error' });
    throw lastError!;
  }

  /**
   * Internal request method.
   */
  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpClientResponse<T>> {
    return new Promise((resolve, reject) => {
      // A Buffer body is sent AS-IS. Without this every caller had to hand over
      // an object to be `JSON.stringify`'d, which for a large pre-serialized
      // document (an SPDX SBOM read off disk) meant parsing it to an object only
      // so this could serialize it straight back — two full copies of a
      // multi-megabyte string to move bytes that were already on disk.
      //
      // Deliberately narrow: ONLY a Buffer opts out. Anything else keeps the
      // JSON contract every other caller relies on, so this cannot quietly
      // change how an ordinary object body is sent.
      const raw = Buffer.isBuffer(body) ? body : undefined;
      // Serialize when body is defined (including 0/false/'' which are valid JSON values).
      const bodyStr = raw === undefined && body !== undefined ? JSON.stringify(body) : undefined;

      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': 'application/json',
        ...options?.headers,
      };

      // Propagate request ID for distributed tracing
      if (options?.requestId) {
        headers['X-Request-Id'] = options.requestId;
      }

      if (bodyStr) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      } else if (raw) {
        headers['Content-Length'] = raw.length;
      }

      // Validate path to prevent protocol injection / request smuggling
      if (path.includes('://') || path.startsWith('//') || /[\r\n\0]/.test(path)) {
        throw new Error(`Invalid request path: ${path}`);
      }

      const timeoutMs = options?.timeout ?? this.config.timeout;
      const maxBytes = options?.maxResponseBytes ?? this.maxResponseBytes;

      const requestOptions: http.RequestOptions = {
        hostname: this.config.host,
        port: this.config.port,
        path: path.startsWith('/') ? path : `/${path}`,
        method,
        headers,
        // Socket IDLE timeout. The total deadline below bounds the whole
        // exchange — a peer trickling one byte per interval never goes idle.
        timeout: timeoutMs,
        agent: this.agent,
      };

      // Settle exactly once, whichever of the many terminal events fires first
      // (response end, request/response error, abort, premature close, deadline,
      // size cap). Every exit path clears the deadline timer.
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        options?.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      const succeed = (value: HttpClientResponse<T>): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const signal = options?.signal;
      const onAbort = (): void => {
        fail(abortReason(signal!));
        req.destroy();
      };

      // The transport follows the target's scheme (see resolveTarget).
      const transport = this.protocol === 'https' ? https : http;
      const req = transport.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        let received = 0;

        res.on('data', (raw: Buffer | string) => {
          const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
          received += chunk.length;
          if (received > maxBytes) {
            logger.warn('HTTP response exceeded size cap', { host: this.config.host, path, maxBytes });
            fail(new ResponseTooLargeError(maxBytes));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        // The response stream failing or being cut mid-body must reject — before,
        // these left the promise pending forever (a hung caller, and a breaker
        // probe that never reported back).
        res.on('error', (error) => fail(error));
        res.on('aborted', () => fail(new Error('Response aborted by peer before completion')));
        res.on('close', () => {
          if (!res.complete) fail(new Error('Response closed before completion'));
        });

        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode || HttpStatus.INTERNAL_SERVER_ERROR;
          let parsedBody: unknown;
          try {
            // An EMPTY body (204, bare 200) is `{}` by contract.
            parsedBody = data ? JSON.parse(data) : {};
          } catch (parseError) {
            logger.warn('Failed to parse response body', {
              host: this.config.host,
              path,
              statusCode,
              error: errorMessage(parseError),
            });
            // A success claim with an unreadable body is a contract violation the
            // caller must see; an error status keeps its status-driven handling.
            if (statusCode < 400) {
              fail(new InvalidResponseBodyError(statusCode, res.headers, data.slice(0, 512)));
            } else {
              succeed({ statusCode, body: {} as T, headers: res.headers, bodyInvalid: true });
            }
            return;
          }
          succeed({ statusCode, body: parsedBody as T, headers: res.headers });
        });
      });

      req.on('error', (error) => {
        if (settled) return; // our own destroy() after a deadline/size-cap failure
        // Node dual-stack connect failures are an AggregateError with an empty
        // `.message`; the cause is in `.code` (ECONNREFUSED/ETIMEDOUT). Fall
        // back so the log isn't a blank `error:""`.
        const detail = error.message || (error as NodeJS.ErrnoException).code || error.name;
        logger.error('HTTP request failed', {
          host: this.config.host,
          port: this.config.port,
          path,
          method,
          error: detail,
        });
        fail(error);
      });

      const timeoutError = () => new Error(`Request timeout after ${timeoutMs}ms`);

      req.on('timeout', () => {
        logger.warn('HTTP request timeout (socket idle)', { host: this.config.host, path, timeout: timeoutMs });
        fail(timeoutError());
        req.destroy();
      });

      // The request closing before we settled (no response, or a response we
      // never finished) is a failure, not silence.
      req.on('close', () => fail(new Error('Request closed before a response completed')));

      // TOTAL deadline for the exchange (connect + send + full body).
      deadline = setTimeout(() => {
        logger.warn('HTTP request timeout (total deadline)', { host: this.config.host, path, timeout: timeoutMs });
        fail(timeoutError());
        req.destroy();
      }, timeoutMs);
      deadline.unref?.();

      // Caller cancellation: destroy the in-flight request and reject with the
      // signal's reason. (Already-aborted signals never reach here — see
      // requestWithRetry — but a signal aborted between attempts can.)
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (raw) {
        req.write(raw);
      } else if (bodyStr) {
        req.write(bodyStr);
      }

      req.end();
    });
  }
}

/**
 * Create an HTTP client with error handling that returns null on failure.
 * Useful for fail-open scenarios.
 *
 * @param config - Service configuration
 * @returns Client wrapper with safe methods
 */
export function createSafeClient(config: ServiceConfig, options?: HttpClientOptions) {
  const client = new InternalHttpClient(config, options);

  return {
    /**
     * Safe GET request - returns null on error.
     */
    async get<T>(path: string, options?: RequestOptions): Promise<HttpClientResponse<T> | null> {
      try {
        return await client.get<T>(path, options);
      } catch (err) {
        logger.debug('Safe GET failed, returning null', { path, error: errorMessage(err) });
        return null;
      }
    },

    /**
     * Safe POST request - returns null on error.
     */
    async post<T>(
      path: string,
      body?: unknown,
      options?: RequestOptions,
    ): Promise<HttpClientResponse<T> | null> {
      try {
        return await client.post<T>(path, body, options);
      } catch (err) {
        logger.debug('Safe POST failed, returning null', { path, error: errorMessage(err) });
        return null;
      }
    },

    /**
     * Safe PUT request - returns null on error.
     */
    async put<T>(
      path: string,
      body?: unknown,
      options?: RequestOptions,
    ): Promise<HttpClientResponse<T> | null> {
      try {
        return await client.put<T>(path, body, options);
      } catch (err) {
        logger.debug('Safe PUT failed, returning null', { path, error: errorMessage(err) });
        return null;
      }
    },

    /**
     * Safe DELETE request - returns null on error. Used by destructive
     * cross-service operations (e.g. org-cascade delete in platform).
     */
    async delete<T>(
      path: string,
      options?: DeleteRequestOptions,
    ): Promise<HttpClientResponse<T> | null> {
      try {
        return await client.delete<T>(path, options);
      } catch (err) {
        logger.debug('Safe DELETE failed, returning null', { path, error: errorMessage(err) });
        return null;
      }
    },
  };
}
