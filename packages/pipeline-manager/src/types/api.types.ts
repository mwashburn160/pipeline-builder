/**
 * API client type definitions
 */

import { AxiosResponse } from 'axios';

/**
 * HTTP methods
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Request headers
 */
export type RequestHeaders = Record<string, string>;

/**
 * Query parameters
 */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Request configuration
 */
export interface RequestConfig {
  /**
   * Request headers
   */
  headers?: RequestHeaders;

  /**
   * Query parameters
   */
  params?: QueryParams;

  /**
   * Request timeout in milliseconds
   */
  timeout?: number;

  /**
   * Cancel token for request cancellation
   */
  cancelKey?: string;

  /**
   * Whether to retry the request on failure
   */
  retry?: boolean;

  /**
   * Number of retry attempts
   */
  retries?: number;
}

/**
 * HTTP client interface (for dependency injection)
 */
export interface HttpClient {
  /**
   * Perform GET request
   */
  get<T>(url: string, config?: any): Promise<AxiosResponse<T>>;

  /**
   * Perform POST request
   */
  post<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>>;

  /**
   * Perform PUT request
   */
  put<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>>;

  /**
   * Perform PATCH request
   */
  patch<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>>;

  /**
   * Perform DELETE request
   */
  delete<T>(url: string, config?: any): Promise<AxiosResponse<T>>;
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  /**
   * Response data
   */
  data: T;

  /**
   * HTTP status code
   */
  status: number;

  /**
   * HTTP status text
   */
  statusText: string;

  /**
   * Response headers
   */
  headers: Record<string, string>;
}

/**
 * API error response
 */
export interface ApiErrorResponse {
  /**
   * Error message
   */
  message: string;

  /**
   * Error code
   */
  code?: string;

  /**
   * Error details
   */
  details?: unknown;

  /**
   * Validation errors (if applicable)
   */
  errors?: ValidationError[];

  /**
   * Timestamp
   */
  timestamp?: string;

  /**
   * Request ID
   */
  requestId?: string;
}

/**
 * Validation error in API response
 */
export interface ValidationError {
  /**
   * Field that failed validation
   */
  field: string;

  /**
   * Error message
   */
  message: string;

  /**
   * Validation rule that failed
   */
  rule?: string;

  /**
   * Received value
   */
  value?: unknown;
}

/**
 * Paginated API response
 */
export interface PaginatedResponse<T> {
  /**
   * List of items
   */
  items: T[];

  /**
   * Total number of items
   */
  total: number;

  /**
   * Current page number
   */
  page: number;

  /**
   * Number of items per page
   */
  limit: number;

  /**
   * Total number of pages
   */
  totalPages: number;

  /**
   * Whether there are more pages
   */
  hasMore: boolean;

  /**
   * Link to next page (if available)
   */
  nextPage?: string;

  /**
   * Link to previous page (if available)
   */
  prevPage?: string;
}

/**
 * File upload progress callback
 */
export type UploadProgressCallback = (progress: UploadProgress) => void;

/**
 * Upload progress information
 */
export interface UploadProgress {
  /**
   * Number of bytes uploaded
   */
  loaded: number;

  /**
   * Total number of bytes to upload
   */
  total: number;

  /**
   * Upload progress percentage (0-100)
   */
  percentage: number;

  /**
   * Upload rate in bytes per second
   */
  rate?: number;

  /**
   * Estimated time remaining in seconds
   */
  estimated?: number;
}

/**
 * API client configuration
 */
export interface ApiClientConfig {
  /**
   * Base URL for API requests
   */
  baseUrl: string;

  /**
   * Default request timeout
   */
  timeout?: number;

  /**
   * Default headers for all requests
   */
  headers?: RequestHeaders;

  /**
   * Authentication token
   */
  token?: string;

  /**
   * Whether to reject unauthorized SSL certificates
   */
  rejectUnauthorized?: boolean;

  /**
   * Maximum number of concurrent requests
   */
  maxConcurrentRequests?: number;

  /**
   * Maximum content length for requests
   */
  maxContentLength?: number;

  /**
   * Maximum body length for requests
   */
  maxBodyLength?: number;

  /**
   * Enable request/response logging
   */
  logging?: {
    requests?: boolean;
    responses?: boolean;
    level?: 'debug' | 'info' | 'warn' | 'error';
  };

  /**
   * Enable response caching
   */
  cache?: {
    enabled?: boolean;
    ttl?: number;
  };

  /**
   * Retry configuration
   */
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    delay?: number;
    backoff?: number;
  };

  /**
   * Security configuration
   */
  security?: {
    preventSsrf?: boolean;
    allowedDomains?: string[];
    blockedDomains?: string[];
  };
}

/**
 * Token information (for debugging)
 */
export interface TokenInfo {
  /**
   * Whether token is present
   */
  present: boolean;

  /**
   * Token length
   */
  length: number;

  /**
   * Token prefix (first few characters)
   */
  prefix: string;

  /**
   * Token type (if JWT)
   */
  type?: 'jwt' | 'opaque';

  /**
   * Token expiration (if JWT and available)
   */
  expiresAt?: Date;

  /**
   * Whether token is expired (if JWT)
   */
  isExpired?: boolean;
}
