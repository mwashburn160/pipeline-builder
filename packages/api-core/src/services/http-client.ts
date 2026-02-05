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
 * Default request timeout in milliseconds.
 */
const DEFAULT_TIMEOUT = 5000;

/**
 * HTTP request options.
 */
export interface RequestOptions {
  /** Request headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * HTTP response wrapper.
 */
export interface HttpResponse<T = unknown> {
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
  }

  /**
   * Make a GET request.
   *
   * @param path - Request path
   * @param options - Request options
   * @returns Promise resolving to response
   */
  async get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  /**
   * Make a POST request.
   *
   * @param path - Request path
   * @param body - Request body
   * @param options - Request options
   * @returns Promise resolving to response
   */
  async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  /**
   * Make a PUT request.
   *
   * @param path - Request path
   * @param body - Request body
   * @param options - Request options
   * @returns Promise resolving to response
   */
  async put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, body, options);
  }

  /**
   * Make a DELETE request.
   *
   * @param path - Request path
   * @param options - Request options
   * @returns Promise resolving to response
   */
  async delete<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  /**
   * Internal request method.
   */
  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': 'application/json',
        ...options?.headers,
      };

      if (bodyStr) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const requestOptions: http.RequestOptions = {
        hostname: this.config.host,
        port: this.config.port,
        path: path.startsWith('/') ? path : `/${path}`,
        method,
        headers,
        timeout: options?.timeout ?? this.config.timeout,
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
    async get<T>(path: string, options?: RequestOptions): Promise<HttpResponse<T> | null> {
      try {
        return await client.get<T>(path, options);
      } catch {
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
    ): Promise<HttpResponse<T> | null> {
      try {
        return await client.post<T>(path, body, options);
      } catch {
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
    ): Promise<HttpResponse<T> | null> {
      try {
        return await client.put<T>(path, body, options);
      } catch {
        return null;
      }
    },
  };
}
