/**
 * @module utils/base-service
 * @description Base service client for communicating with microservices.
 * Provides shared HTTP request logic, error handling, and query string building.
 */

import logger from './logger';

/**
 * Base error class for service client errors.
 */
export class ServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Request options for service client calls.
 */
export interface ServiceRequestOptions extends RequestInit {
  orgId: string;
  userId?: string;
  token: string;
}

/**
 * Base service client with shared HTTP request logic.
 * Subclasses must provide a service name and error factory.
 */
export abstract class BaseServiceClient {
  protected timeout: number;
  protected abstract serviceName: string;

  constructor(timeout: number) {
    this.timeout = timeout;
  }

  protected abstract createError(message: string, statusCode: number, code?: string): ServiceError;

  /**
   * Build query string from a filter object.
   */
  protected buildQueryString(filter: object): string {
    const params = new URLSearchParams();

    Object.entries(filter).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params.append(key, String(value));
      }
    });

    const query = params.toString();
    return query ? `?${query}` : '';
  }

  /**
   * Make HTTP request with timeout and error handling.
   */
  protected async request<T>(url: string, options: ServiceRequestOptions): Promise<T> {
    const { orgId, userId, token, ...fetchOptions } = options;

    if (!token) {
      throw this.createError('Authentication token is required', 401, 'TOKEN_REQUIRED');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-org-id': orgId,
      ...(userId && { 'x-user-id': userId }),
      'Authorization': `Bearer ${token}`,
      ...(fetchOptions.headers as Record<string, string>),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      logger.debug(`[${this.serviceName}] Request: ${fetchOptions.method || 'GET'} ${url}`);

      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        throw this.createError(
          String(data.message || data.error || 'Request failed'),
          response.status,
          data.code as string | undefined,
        );
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ServiceError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw this.createError('Request timeout', 504, 'TIMEOUT');
        }
        throw this.createError(error.message, 500, 'SERVICE_ERROR');
      }

      throw this.createError('Unknown error', 500, 'UNKNOWN_ERROR');
    }
  }
}
