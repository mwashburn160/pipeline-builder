/**
 * Error type definitions
 */

/**
 * Error codes for different error types
 */
export const ERROR_CODES = {
  GENERAL: 1,
  VALIDATION: 2,
  API_REQUEST: 3,
  AUTHENTICATION: 4,
  AUTHORIZATION: 5,
  NOT_FOUND: 6,
  NETWORK: 7,
  CONFIGURATION: 8,
  FILE_SYSTEM: 9,
  TIMEOUT: 10,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Options for error handling
 */
export interface ErrorHandlerOptions {
  debug?: boolean;
  exit?: boolean;
  logToConsole?: boolean;
  context?: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Validation error details
 */
export interface ValidationErrorDetails {
  field?: string;
  value?: unknown;
  rule?: string;
  expected?: string;
}

/**
 * Network error details
 */
export interface NetworkErrorDetails {
  url?: string;
  timeout?: number;
  requestMade: boolean;
  responseReceived: boolean;
  cause?: Error;
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxAttempts?: number;
  delay?: number;
  backoff?: number;
  maxDelay?: number;
  shouldRetry?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
  retryableStatusCodes?: number[];
}

/**
 * Axios error interface (for type checking)
 */
export interface AxiosErrorLike {
  response?: {
    status?: number;
    statusText?: string;
    data?: unknown;
  };
  config?: {
    url?: string;
    method?: string;
    timeout?: number;
  };
  request?: unknown;
  isAxiosError: true;
}
