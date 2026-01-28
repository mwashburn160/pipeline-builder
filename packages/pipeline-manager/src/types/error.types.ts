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
  /**
   * Show full stack trace
   */
  debug?: boolean;

  /**
   * Exit process after handling error
   */
  exit?: boolean;

  /**
   * Log error to console
   */
  logToConsole?: boolean;

  /**
   * Additional context to include
   */
  context?: Record<string, unknown>;

  /**
   * Correlation ID for distributed tracing
   */
  correlationId?: string;
}

/**
 * HTTP error details
 */
export interface HttpErrorDetails {
  /**
   * HTTP status code
   */
  statusCode: number;

  /**
   * Error message
   */
  message: string;

  /**
   * Error code
   */
  code?: ErrorCode;

  /**
   * Additional error details
   */
  details?: unknown;

  /**
   * Request URL
   */
  url?: string;

  /**
   * Request method
   */
  method?: string;

  /**
   * Correlation ID
   */
  correlationId?: string;
}

/**
 * Validation error details
 */
export interface ValidationErrorDetails {
  /**
   * Field that failed validation
   */
  field?: string;

  /**
   * Value that failed validation
   */
  value?: unknown;

  /**
   * Validation rule that failed
   */
  rule?: string;

  /**
   * Expected value or format
   */
  expected?: string;
}

/**
 * Network error details
 */
export interface NetworkErrorDetails {
  /**
   * Request URL
   */
  url?: string;

  /**
   * Request timeout
   */
  timeout?: number;

  /**
   * Whether request was made
   */
  requestMade: boolean;

  /**
   * Whether response was received
   */
  responseReceived: boolean;

  /**
   * Original error
   */
  cause?: Error;
}

/**
 * Configuration error details
 */
export interface ConfigurationErrorDetails {
  /**
   * Missing configuration field
   */
  missingField?: string;

  /**
   * Invalid configuration field
   */
  invalidField?: string;

  /**
   * Expected value type
   */
  expectedType?: string;

  /**
   * Actual value type
   */
  actualType?: string;
}

/**
 * Retry options
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Initial delay between retries in milliseconds
   * @default 1000
   */
  delay?: number;

  /**
   * Backoff multiplier for exponential backoff
   * @default 2
   */
  backoff?: number;

  /**
   * Maximum delay between retries in milliseconds
   * @default 30000
   */
  maxDelay?: number;

  /**
   * Function to determine if error should be retried
   */
  shouldRetry?: (error: Error) => boolean;

  /**
   * Callback invoked on each retry attempt
   */
  onRetry?: (attempt: number, error: Error) => void;

  /**
   * List of error types that should be retried
   */
  retryableErrors?: Array<new (...args: any[]) => Error>;

  /**
   * List of HTTP status codes that should be retried
   */
  retryableStatusCodes?: number[];
}

/**
 * Error log entry for structured logging
 */
export interface ErrorLogEntry {
  /**
   * Timestamp in ISO format
   */
  timestamp: string;

  /**
   * Error ID (for correlation)
   */
  errorId: string;

  /**
   * Log level
   */
  level: 'error' | 'fatal' | 'warn';

  /**
   * Error code
   */
  code: ErrorCode;

  /**
   * Error message
   */
  message: string;

  /**
   * Error name/type
   */
  name: string;

  /**
   * Stack trace (optional)
   */
  stack?: string;

  /**
   * Additional context
   */
  context?: Record<string, unknown>;

  /**
   * HTTP status code (for HTTP errors)
   */
  httpStatus?: number;

  /**
   * Request URL (for HTTP errors)
   */
  url?: string;

  /**
   * Request method (for HTTP errors)
   */
  method?: string;

  /**
   * User ID (if available)
   */
  userId?: string;

  /**
   * Session ID (if available)
   */
  sessionId?: string;

  /**
   * Correlation ID (for distributed tracing)
   */
  correlationId?: string;
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
