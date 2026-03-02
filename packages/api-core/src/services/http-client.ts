/**
 * @module services/http-client
 * @description Internal HTTP client for service-to-service communication.
 */

import * as http from 'http';
import { HttpStatus } from '../constants/http-status';
import { ServiceConfig } from '../types/common';
import { createLogger } from '../utils/logger';

const logger = createLogger('http-client');

/**
 * Default request timeout in milliseconds (env: `HTTP_CLIENT_TIMEOUT`).
 */
const DEFAULT_TIMEOUT = parseInt(process.env.HTTP_CLIENT_TIMEOUT || '5000');

/**
 * Default retry configuration (env: `HTTP_CLIENT_MAX_RETRIES`, `HTTP_CLIENT_RETRY_DELAY_MS`).
 */
const DEFAULT_MAX_RETRIES = parseInt(process.env.HTTP_CLIENT_MAX_RETRIES || '2');
const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.HTTP_CLIENT_RETRY_DELAY_MS || '200');
const DEFAULT_MAX_RATE_LIMIT_RETRIES = parseInt(process.env.HTTP_CLIENT_MAX_RATE_LIMIT_RETRIES || '4');

/** Max Retry-After value we'll honor (60 seconds). */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse a `Retry-After` header value into milliseconds.
 * Supports numeric seconds (e.g. "5") and HTTP-date format.
 * Returns `undefined` for missing or invalid values.
 */
export function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;

  // Try numeric seconds first
  const seconds = Number(value);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // Try HTTP-date
  const date = Date.parse(value);
  if (!isNaN(date)) {
    const delayMs = date - Date.now();
    if (delayMs > 0) return Math.min(delayMs, MAX_RETRY_AFTER_MS);
  }

  return undefined;
}

/**
 * Apply ±25% random jitter to a delay to prevent thundering herd.
 */
export function addJitter(delay: number): number {
  const jitter = delay * 0.25 * (2 * Math.random() - 1); // -25% to +25%
  return Math.max(0, Math.round(delay + jitter));
}

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
export class InternalHttpClient {
  private config: Required<ServiceConfig>;
  private agent: http.Agent;

  /**
   * Create a new HTTP client instance.
   *
   * @param config - Service configuration
   */
  constructor(config: ServiceConfig) {
    this.config = {
      host: config.host,
      port: config.port,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
    };
    this.agent = new http.Agent({ keepAlive: true });
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
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxRateLimitRetries = options?.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
    const baseDelay = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const totalMaxAttempts = Math.max(maxRetries, maxRateLimitRetries);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= totalMaxAttempts; attempt++) {
      try {
        const response = await this.request<T>(method, path, body, options);

        // 429 rate limiting — use Retry-After or longer backoff
        if (response.statusCode === 429 && attempt < maxRateLimitRetries) {
          const retryAfter = parseRetryAfter(response.headers['retry-after']);
          const delay = retryAfter ?? (baseDelay * 4 * Math.pow(2, attempt));
          logger.debug('Rate limited, retrying', { method, path, attempt: attempt + 1, delayMs: delay });
          await this.sleep(addJitter(delay));
          continue;
        }

        // 5xx transient server errors — standard backoff
        if ([502, 503, 504].includes(response.statusCode) && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.debug('Retrying on transient status', { method, path, statusCode: response.statusCode, attempt: attempt + 1 });
          await this.sleep(addJitter(delay));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.debug('Retrying after error', { method, path, error: lastError.message, attempt: attempt + 1 });
          await this.sleep(addJitter(delay));
          continue;
        }
      }
    }

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
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': 'application/json',
        ...options?.headers,
      };

      if (bodyStr) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      // Validate path to prevent protocol injection / request smuggling
      if (path.includes('://') || path.startsWith('//')) {
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
        logger.error('HTTP request failed', {
          host: this.config.host,
          port: this.config.port,
          path,
          method,
          error: error.message,
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
export function createSafeClient(config: ServiceConfig) {
  const client = new InternalHttpClient(config);

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
  };
}
