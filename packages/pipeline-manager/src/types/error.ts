/**
 * Numeric exit-code constants mapped to error categories.
 * Used by {@link handleError} to set the process exit code.
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

/** Union of all valid error code values. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Options controlling how {@link handleError} processes and reports an error.
 */
export interface ErrorHandlerOptions {
  /** When `true`, prints full stack traces and internal details. */
  debug?: boolean;
  /** When `true`, calls `process.exit()` with the error code. */
  exit?: boolean;
  /** When `true`, logs the error to the console (defaults to `true`). */
  logToConsole?: boolean;
  /** Arbitrary key-value context attached to the error output for debugging. */
  context?: Record<string, unknown>;
  /** Request/execution correlation ID for log tracing. */
  correlationId?: string;
}

/**
 * Structured details attached to a {@link ValidationError}.
 */
export interface ValidationErrorDetails {
  /** Name of the field that failed validation. */
  field?: string;
  /** The invalid value that was provided. */
  value?: unknown;
  /** Validation rule that was violated (e.g., `required`, `min`). */
  rule?: string;
  /** Human-readable description of the expected value. */
  expected?: string;
}

/**
 * Structured details attached to network/connection errors.
 */
export interface NetworkErrorDetails {
  /** The URL that was being requested. */
  url?: string;
  /** Request timeout in milliseconds, if configured. */
  timeout?: number;
  /** Whether the HTTP request was actually sent. */
  requestMade: boolean;
  /** Whether any HTTP response was received (even an error status). */
  responseReceived: boolean;
  /** The underlying error that caused the network failure. */
  cause?: Error;
}

/**
 * Configuration for automatic request retry with exponential backoff.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (including the initial request). */
  maxAttempts?: number;
  /** Initial delay between retries in milliseconds. */
  delay?: number;
  /** Multiplier applied to the delay after each attempt. */
  backoff?: number;
  /** Upper bound for the computed delay in milliseconds. */
  maxDelay?: number;
  /** Custom predicate to decide whether a given error is retryable. */
  shouldRetry?: (error: Error) => boolean;
  /** Callback invoked before each retry attempt. */
  onRetry?: (attempt: number, error: Error) => void;
  /** HTTP status codes that should trigger a retry. */
  retryableStatusCodes?: number[];
}

/**
 * Minimal Axios-compatible error shape used for duck-typing in error handlers.
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
