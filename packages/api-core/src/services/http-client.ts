// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as http from 'http';
import { getCircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
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
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('http-client');

/**
 * Default request timeout in milliseconds (env: `HTTP_CLIENT_TIMEOUT`).
 */
const DEFAULT_TIMEOUT = parseInt(process.env.HTTP_CLIENT_TIMEOUT || '5000', 10);

/**
 * Default cap on concurrent keep-alive sockets per client agent
 * (env: `HTTP_CLIENT_MAX_SOCKETS`). Node's default is `Infinity`, which lets a
 * burst of concurrent calls open unbounded sockets against a downstream service
 * (fd exhaustion + connection-storm on the callee). 64 is ample for
 * service-to-service fan-out while staying bounded.
 */
const DEFAULT_MAX_SOCKETS = parseInt(process.env.HTTP_CLIENT_MAX_SOCKETS || '64', 10);

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
}

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

function getSharedAgent(host: string, port: number, maxSockets: number): http.Agent {
  const key = `${host}:${port}:${maxSockets}`;
  let agent = sharedAgents.get(key);
  if (!agent) {
    agent = new http.Agent({ keepAlive: true, maxSockets });
    sharedAgents.set(key, agent);
  }
  return agent;
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
  private config: Required<ServiceConfig>;
  private agent: http.Agent;

  /**
   * Create a new HTTP client instance.
   *
   * @param config - Service configuration
   * @param options - Optional connection-pool controls (own agent / socket cap)
   */
  constructor(config: ServiceConfig, options?: HttpClientOptions) {
    this.config = {
      host: config.host,
      port: config.port,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };
    this.agent = options?.agent
      ?? getSharedAgent(this.config.host, this.config.port, options?.maxSockets ?? DEFAULT_MAX_SOCKETS);
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
  async delete<T = unknown>(path: string, options?: RequestOptions): Promise<HttpClientResponse<T>> {
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

    const retryConfig: RetryConfig = {
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      maxRateLimitRetries: options?.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES,
      retryDelayMs: options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };
    const totalMaxAttempts = Math.max(retryConfig.maxRetries, retryConfig.maxRateLimitRetries);

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
    const breaker = getCircuitBreaker(target);
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
          await this.sleep(decision.delayMs);
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

        const decision = getErrorRetryDecision(attempt, retryConfig);
        if (decision.shouldRetry && retrySafe) {
          logger.debug('Retrying after error', { method, path, error: lastError.message, attempt: attempt + 1 });
          emitCounter('s2s_request_retries_total', { target, method });
          await this.sleep(decision.delayMs);
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      // Serialize when body is defined (including 0/false/'' which are valid JSON values).
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

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
      }

      // Validate path to prevent protocol injection / request smuggling
      if (path.includes('://') || path.startsWith('//') || /[\r\n\0]/.test(path)) {
        throw new Error(`Invalid request path: ${path}`);
      }

      const requestOptions: http.RequestOptions = {
        hostname: this.config.host,
        port: this.config.port,
        path: path.startsWith('/') ? path : `/${path}`,
        method,
        headers,
        timeout: options?.timeout ?? this.config.timeout,
        agent: this.agent,
      };

      const req = http.request(requestOptions, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsedBody = data ? JSON.parse(data) : {};
            resolve({
              statusCode: res.statusCode || HttpStatus.INTERNAL_SERVER_ERROR,
              body: parsedBody as T,
              headers: res.headers,
            });
          } catch (parseError) {
            logger.warn('Failed to parse response body', {
              host: this.config.host,
              path,
              error: parseError instanceof Error ? parseError.message : String(parseError),
            });
            resolve({
              statusCode: res.statusCode || HttpStatus.INTERNAL_SERVER_ERROR,
              body: {} as T,
              headers: res.headers,
            });
          }
        });
      });

      req.on('error', (error) => {
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
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        const error = new Error(`Request timeout after ${this.config.timeout}ms`);
        logger.warn('HTTP request timeout', {
          host: this.config.host,
          path,
          timeout: this.config.timeout,
        });
        reject(error);
      });

      if (bodyStr) {
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
        logger.debug('Safe GET failed, returning null', { path, error: err instanceof Error ? err.message : String(err) });
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
        logger.debug('Safe POST failed, returning null', { path, error: err instanceof Error ? err.message : String(err) });
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
        logger.debug('Safe PUT failed, returning null', { path, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    /**
     * Safe DELETE request - returns null on error. Used by destructive
     * cross-service operations (e.g. org-cascade delete in platform).
     */
    async delete<T>(
      path: string,
      options?: RequestOptions,
    ): Promise<HttpClientResponse<T> | null> {
      try {
        return await client.delete<T>(path, options);
      } catch (err) {
        logger.debug('Safe DELETE failed, returning null', { path, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },
  };
}
