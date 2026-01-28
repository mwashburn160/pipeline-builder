import pico from 'picocolors';
import { formatDuration, generateExecutionId } from '../config/cli.constants';
import {
  ERROR_CODES,
  ErrorCode,
  ErrorHandlerOptions,
  ValidationErrorDetails,
  NetworkErrorDetails,
  RetryOptions,
  AxiosErrorLike,
} from '../types';

const { bold, dim, red, yellow, cyan } = pico;

// Re-export ERROR_CODES and ErrorCode for convenience
export { ERROR_CODES };
export type { ErrorCode };

/**
 * Format and handle errors with colored output
 *
 * @param err - The error to handle
 * @param code - Error code (default: ERROR_CODES.GENERAL)
 * @param options - Error handling options
 *
 * @example
 * ```typescript
 * try {
 *   await uploadFile();
 * } catch (error) {
 *   handleError(error, ERROR_CODES.API_REQUEST, {
 *     debug: true,
 *     exit: true,
 *     context: { filename: 'plugin.zip' }
 *   });
 * }
 * ```
 */
export function handleError(
  err: unknown,
  code: ErrorCode = ERROR_CODES.GENERAL,
  options: ErrorHandlerOptions = {},
): never {
  const {
    debug = false,
    exit = true,
    logToConsole = true,
    context,
    correlationId = generateExecutionId(),
  } = options;

  if (logToConsole) {
    const divider = '─'.repeat(process.stdout.columns || 80);
    const errorId = `ERR-${correlationId}`;

    console.error('\n' + red(bold('✗ ERROR')) + dim(` [${errorId}]`) + '\n');
    console.error(dim(divider));

    // Error details
    if (err instanceof Error) {
      console.error(red(bold('Message:')), err.message);

      if (err.name !== 'Error') {
        console.error(red('Type:'), err.name);
      }

      // Show HTTP error details
      if (err instanceof HttpError) {
        console.error(red('Status:'), err.statusCode);
        console.error(red('Status Text:'), getHttpStatusText(err.statusCode));

        if (err.details) {
          console.error(red('Details:'));
          console.error(dim(sanitizeErrorData(err.details)));
        }
      }

      // Show Validation error details
      if (err instanceof ValidationError) {
        if (err.field) {
          console.error(red('Field:'), err.field);
        }
        if (err.value !== undefined) {
          console.error(red('Value:'), sanitizeValue(err.value));
        }
        if (err.rule) {
          console.error(red('Rule:'), err.rule);
        }
        if (err.expected) {
          console.error(red('Expected:'), err.expected);
        }
      }

      // Show Network error details
      if (err instanceof NetworkError) {
        if (err.url) {
          console.error(red('URL:'), sanitizeUrl(err.url));
        }
        if (err.timeout) {
          console.error(red('Timeout:'), `${err.timeout}ms`);
        }
        console.error(red('Request Made:'), err.requestMade ? 'Yes' : 'No');
        console.error(red('Response Received:'), err.responseReceived ? 'Yes' : 'No');

        if (err.cause) {
          console.error(red('Caused by:'), err.cause.message);
        }
      }

      // Show Configuration error details
      if (err instanceof ConfigurationError) {
        if (err.missingField) {
          console.error(red('Missing Field:'), err.missingField);
        }
        if (err.invalidField) {
          console.error(red('Invalid Field:'), err.invalidField);
        }
        if (err.expectedType) {
          console.error(red('Expected Type:'), err.expectedType);
        }
        if (err.actualType) {
          console.error(red('Actual Type:'), err.actualType);
        }
      }

      // Show API error details (Axios-like errors)
      if (isAxiosError(err)) {
        const status = err.response?.status;
        const url = err.config?.url;

        if (status) {
          console.error(red('Status:'), status);
          console.error(red('Status Text:'), getHttpStatusText(status));
        }

        if (url) {
          console.error(red('URL:'), sanitizeUrl(url));
        }

        if (err.response?.data) {
          console.error(red('Response:'));
          console.error(dim(sanitizeErrorData(err.response.data)));
        }
      }

      console.error(red('Code:'), getErrorCodeName(code));

      // Correlation ID
      console.error(dim('Error ID:'), dim(errorId));

      // Additional context
      if (context && Object.keys(context).length > 0) {
        console.error('');
        console.error(red('Context:'));
        Object.entries(context).forEach(([key, value]) => {
          const sanitizedValue = sanitizeContextValue(value);
          console.error(`  ${cyan(key)}:`, dim(sanitizedValue));
        });
      }

      // Stack trace in debug mode
      if (debug && err.stack) {
        console.error('');
        console.error(dim('Stack trace:'));
        const sanitizedStack = sanitizeStackTrace(err.stack);
        console.error(dim(sanitizedStack));
      }
    } else {
      console.error(red('Error:'), String(err));
      console.error(red('Code:'), getErrorCodeName(code));
      console.error(dim('Error ID:'), dim(errorId));
    }

    console.error(dim(divider));

    // Helpful tips
    if (!debug) {
      console.error(yellow('💡 Tip:'), dim('Run with --debug flag to see full stack trace'));
    }

    // Suggest actions based on error type
    const suggestion = getErrorSuggestion(err, code);
    if (suggestion) {
      console.error(yellow('💡 Suggestion:'), dim(suggestion));
    }

    console.error(''); // Empty line
  }

  if (exit) {
    process.exitCode = code;
    process.exit(code);
  }

  // For TypeScript: this function always exits or throws
  throw err;
}

/**
 * Get error code name from value
 */
function getErrorCodeName(code: ErrorCode): string {
  const entry = Object.entries(ERROR_CODES).find(([_, value]) => value === code);
  return entry ? `${entry[0]} (${code})` : String(code);
}

/**
 * Get HTTP status text
 */
function getHttpStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return statusTexts[status] || 'Unknown';
}

/**
 * Get error suggestion based on error type
 */
function getErrorSuggestion(err: unknown, code: ErrorCode): string | null {
  if (code === ERROR_CODES.AUTHENTICATION) {
    return 'Check that PLATFORM_TOKEN environment variable is set correctly';
  }

  if (code === ERROR_CODES.NETWORK) {
    return 'Check your internet connection and API endpoint URL';
  }

  if (code === ERROR_CODES.CONFIGURATION) {
    return 'Run "cli version --check-config" to verify configuration';
  }

  if (code === ERROR_CODES.NOT_FOUND) {
    return 'Verify the resource ID exists and you have access to it';
  }

  if (err instanceof ValidationError && err.field) {
    return `Check the value provided for "${err.field}"`;
  }

  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return 'Check your authentication token and permissions';
    }
    if (status === 429) {
      return 'Rate limit exceeded - wait a moment before retrying';
    }
    if (status && status >= 500) {
      return 'Server error - try again later or contact support';
    }
  }

  return null;
}

/**
 * Sanitize error data for display (remove sensitive information)
 */
function sanitizeErrorData(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'object' && data !== null) {
    const sanitized = { ...data } as any;

    // Remove sensitive fields
    const sensitiveFields = ['token', 'password', 'secret', 'apiKey', 'authorization'];
    sensitiveFields.forEach(field => {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    });

    return JSON.stringify(sanitized, null, 2);
  }

  return String(data);
}

/**
 * Sanitize URL (remove query parameters that might contain sensitive data)
 */
function sanitizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const sensitiveParams = ['token', 'key', 'secret', 'password', 'apiKey'];

    sensitiveParams.forEach(param => {
      if (urlObj.searchParams.has(param)) {
        urlObj.searchParams.set(param, '[REDACTED]');
      }
    });

    return urlObj.toString();
  } catch {
    // If URL parsing fails, just return as-is
    return url;
  }
}

/**
 * Sanitize context value for display
 */
function sanitizeContextValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    // Check if it looks like a token
    if (value.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return `${value.substring(0, 8)}...[REDACTED]`;
    }
    return value;
  }

  if (typeof value === 'object') {
    return sanitizeErrorData(value);
  }

  return JSON.stringify(value);
}

/**
 * Sanitize stack trace (remove absolute paths)
 */
function sanitizeStackTrace(stack: string): string {
  return stack
    .split('\n')
    .slice(0, 10) // Limit to 10 frames
    .map(line => {
      // Remove absolute paths
      return line.replace(/\/.*?\//g, '.../');
    })
    .join('\n');
}

/**
 * Sanitize single value for display
 */
function sanitizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    if (value.length > 100) {
      return value.substring(0, 97) + '...';
    }
    return value;
  }

  if (typeof value === 'object') {
    const str = JSON.stringify(value);
    if (str.length > 100) {
      return str.substring(0, 97) + '...';
    }
    return str;
  }

  return String(value);
}

/**
 * Check if error is an Axios-like error
 */
function isAxiosError(err: unknown): err is AxiosErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'isAxiosError' in err &&
    (err as any).isAxiosError === true
  );
}

/**
 * Custom HTTP error class
 */
export class HttpError extends Error {
  /**
   * Create a 400 Bad Request error
   */
  static badRequest(message: string = 'Bad Request', details?: unknown) {
    return new HttpError(400, message, ERROR_CODES.VALIDATION, details);
  }

  /**
   * Create a 401 Unauthorized error
   */
  static unauthorized(message: string = 'Unauthorized', details?: unknown) {
    return new HttpError(401, message, ERROR_CODES.AUTHENTICATION, details);
  }

  /**
   * Create a 403 Forbidden error
   */
  static forbidden(message: string = 'Forbidden', details?: unknown) {
    return new HttpError(403, message, ERROR_CODES.AUTHORIZATION, details);
  }

  /**
   * Create a 404 Not Found error
   */
  static notFound(message: string = 'Not Found', details?: unknown) {
    return new HttpError(404, message, ERROR_CODES.NOT_FOUND, details);
  }

  /**
   * Create a 408 Request Timeout error
   */
  static timeout(message: string = 'Request Timeout', details?: unknown) {
    return new HttpError(408, message, ERROR_CODES.TIMEOUT, details);
  }

  /**
   * Create a 500 Internal Server Error
   */
  static internal(message: string = 'Internal Server Error', details?: unknown) {
    return new HttpError(500, message, ERROR_CODES.GENERAL, details);
  }

  /**
   * Create error from HTTP response
   */
  static fromResponse(status: number, message: string, details?: unknown): HttpError {
    const codeMap: Record<number, ErrorCode> = {
      400: ERROR_CODES.VALIDATION,
      401: ERROR_CODES.AUTHENTICATION,
      403: ERROR_CODES.AUTHORIZATION,
      404: ERROR_CODES.NOT_FOUND,
      408: ERROR_CODES.TIMEOUT,
      409: ERROR_CODES.VALIDATION,
      422: ERROR_CODES.VALIDATION,
      429: ERROR_CODES.GENERAL,
      500: ERROR_CODES.GENERAL,
      502: ERROR_CODES.NETWORK,
      503: ERROR_CODES.NETWORK,
      504: ERROR_CODES.TIMEOUT,
    };

    const code = codeMap[status] || ERROR_CODES.GENERAL;
    return new HttpError(status, message, code, details);
  }

  constructor(
    public statusCode: number,
    message: string,
    public code?: ErrorCode,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public value?: unknown,
    public rule?: string,
    public expected?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
    Error.captureStackTrace(this, this.constructor);
  }

  toDetails(): ValidationErrorDetails {
    return {
      field: this.field,
      value: this.value,
      rule: this.rule,
      expected: this.expected,
    };
  }
}

/**
 * Configuration error class
 */
export class ConfigurationError extends Error {
  constructor(
    message: string,
    public missingField?: string,
    public invalidField?: string,
    public expectedType?: string,
    public actualType?: string,
  ) {
    super(message);
    this.name = 'ConfigurationError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Network error class
 */
export class NetworkError extends Error {
  constructor(
    message: string,
    public url?: string,
    public cause?: Error,
    public timeout?: number,
    public requestMade: boolean = true,
    public responseReceived: boolean = false,
  ) {
    super(message);
    this.name = 'NetworkError';
    Error.captureStackTrace(this, this.constructor);
  }

  toDetails(): NetworkErrorDetails {
    return {
      url: this.url,
      timeout: this.timeout,
      requestMade: this.requestMade,
      responseReceived: this.responseReceived,
      cause: this.cause,
    };
  }
}

/**
 * Wrap async function with error handling
 *
 * @param fn - Async function to wrap
 * @param errorCode - Error code to use on failure
 * @param options - Error handler options
 * @returns Wrapped function
 *
 * @example
 * ```typescript
 * const safeUpload = withErrorHandling(
 *   uploadPlugin,
 *   ERROR_CODES.API_REQUEST,
 *   { debug: true }
 * );
 * await safeUpload(file);
 * ```
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  errorCode: ErrorCode,
  options?: ErrorHandlerOptions,
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      handleError(error, errorCode, options);
    }
  }) as T;
}

/**
 * Assert condition or throw validation error
 *
 * @param condition - Condition to check
 * @param message - Error message
 * @param field - Field name (optional)
 * @param expected - Expected value or format (optional)
 *
 * @example
 * ```typescript
 * assert(config.token, 'Token is required', 'auth.token');
 * assert(file.size < MAX_SIZE, 'File too large', 'file.size', '< 100MB');
 * ```
 */
export function assert(
  condition: unknown,
  message: string,
  field?: string,
  expected?: string,
): asserts condition {
  if (!condition) {
    throw new ValidationError(message, field, condition, undefined, expected);
  }
}

/**
 * Try to execute function and return result or error
 *
 * @param fn - Function to execute
 * @returns Tuple of [error, result]
 *
 * @example
 * ```typescript
 * const [error, config] = await tryAsync(() => loadConfig());
 * if (error) {
 *   console.error('Failed to load config:', error);
 *   return;
 * }
 * console.log('Config loaded:', config);
 * ```
 */
export async function tryAsync<T>(
  fn: () => Promise<T>,
): Promise<[Error, null] | [null, T]> {
  try {
    const result = await fn();
    return [null, result];
  } catch (error) {
    return [error instanceof Error ? error : new Error(String(error)), null];
  }
}

/**
 * Retry async function with exponential backoff
 *
 * @param fn - Function to retry
 * @param options - Retry options
 * @returns Function result
 *
 * @example
 * ```typescript
 * const data = await retry(
 *   () => apiClient.get('/data'),
 *   {
 *     maxAttempts: 3,
 *     delay: 1000,
 *     retryableStatusCodes: [500, 502, 503],
 *     onRetry: (attempt, error) => {
 *       console.log(`Retry attempt ${attempt}: ${error.message}`);
 *     }
 *   }
 * );
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoff = 2,
    maxDelay = 30000,
    onRetry,
    shouldRetry,
    retryableStatusCodes = [500, 502, 503, 504, 429],
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry this error
      const canRetry =
        attempt < maxAttempts &&
        (shouldRetry ? shouldRetry(lastError) : isRetryableError(lastError, retryableStatusCodes));

      if (!canRetry) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      // Calculate wait time with exponential backoff
      const waitTime = Math.min(delay * Math.pow(backoff, attempt - 1), maxDelay);

      console.log(
        yellow(`Retry attempt ${attempt}/${maxAttempts}`),
        dim(`waiting ${formatDuration(waitTime)}...`),
      );

      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError!;
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: Error, retryableStatusCodes: number[]): boolean {
  // Network errors are generally retryable
  if (error instanceof NetworkError) {
    return true;
  }

  // Timeout errors are retryable
  if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
    return true;
  }

  // Check HTTP status codes
  if (isAxiosError(error) && error.response?.status) {
    return retryableStatusCodes.includes(error.response.status);
  }

  // HTTP errors with retryable status codes
  if (error instanceof HttpError) {
    return retryableStatusCodes.includes(error.statusCode);
  }

  // Don't retry validation or authentication errors
  if (error instanceof ValidationError || error.name === 'ValidationError') {
    return false;
  }

  if (error instanceof HttpError && (error.statusCode === 401 || error.statusCode === 403)) {
    return false;
  }

  // By default, don't retry unknown errors
  return false;
}

/**
 * Create a timeout promise
 *
 * @param ms - Timeout in milliseconds
 * @param message - Timeout error message
 * @returns Promise that rejects after timeout
 *
 * @example
 * ```typescript
 * const result = await Promise.race([
 *   fetchData(),
 *   timeout(5000, 'Request timed out')
 * ]);
 * ```
 */
export function timeout(ms: number, message: string = 'Operation timed out'): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(HttpError.timeout(message));
    }, ms);
  });
}

/**
 * Wrap promise with timeout
 *
 * @param promise - Promise to wrap
 * @param ms - Timeout in milliseconds
 * @param message - Timeout error message
 * @returns Promise that rejects if timeout is reached
 *
 * @example
 * ```typescript
 * const data = await withTimeout(
 *   fetchData(),
 *   5000,
 *   'Data fetch timed out'
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
): Promise<T> {
  return Promise.race([promise, timeout(ms, message)]);
}
