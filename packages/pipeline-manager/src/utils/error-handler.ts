import pico from 'picocolors';

const { bold, dim, red, yellow } = pico;

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
}

/**
 * Format and handle errors with colored output
 *
 * @param err - The error to handle
 * @param code - Error code (default: ERROR_CODES.GENERAL)
 * @param options - Error handling options
 */
export function handleError(
  err: unknown,
  code: ErrorCode = ERROR_CODES.GENERAL,
  options: ErrorHandlerOptions = {},
): never {
  const { debug = false, exit = true, logToConsole = true, context } = options;

  if (logToConsole) {
    const divider = '─'.repeat(process.stdout.columns || 80);

    console.error('\n' + red(bold('✗ ERROR')) + '\n');
    console.error(dim(divider));

    // Error details
    if (err instanceof Error) {
      console.error(red('Message:'), err.message);

      if (err.name !== 'Error') {
        console.error(red('Type:'), err.name);
      }

      // Show HTTP error details
      if (err instanceof HttpError) {
        console.error(red('Status:'), err.statusCode);
        if (err.details) {
          console.error(red('Details:'), JSON.stringify(err.details, null, 2));
        }
      }

      // Show API error details
      if (isAxiosError(err)) {
        console.error(red('Status:'), err.response?.status || 'N/A');
        console.error(red('URL:'), err.config?.url || 'N/A');
        if (err.response?.data) {
          console.error(red('Response:'), JSON.stringify(err.response.data, null, 2));
        }
      }

      console.error(red('Code:'), getErrorCodeName(code));

      // Additional context
      if (context && Object.keys(context).length > 0) {
        console.error(red('Context:'));
        Object.entries(context).forEach(([key, value]) => {
          console.error(`  ${dim(key)}:`, JSON.stringify(value));
        });
      }

      // Stack trace in debug mode
      if (debug && err.stack) {
        console.error(dim('\nStack trace:'));
        console.error(dim(err.stack));
      }
    } else {
      console.error(red('Error:'), String(err));
      console.error(red('Code:'), getErrorCodeName(code));
    }

    console.error(dim(divider));

    if (!debug) {
      console.error(yellow('💡 Tip:'), dim('Run with --debug flag to see full stack trace'));
    }

    console.error(''); // Empty line
  }

  if (exit) {
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
 * Check if error is an Axios error
 */
function isAxiosError(err: unknown): err is {
  response?: { status?: number; data?: unknown };
  config?: { url?: string };
  isAxiosError: true;
} {
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
      500: ERROR_CODES.GENERAL,
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
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Configuration error class
 */
export class ConfigurationError extends Error {
  constructor(
    message: string,
    public missingField?: string,
  ) {
    super(message);
    this.name = 'ConfigurationError';
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
  ) {
    super(message);
    this.name = 'NetworkError';
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
 *
 * @example
 * ```typescript
 * assert(config.token, 'Token is required', 'auth.token');
 * assert(file.size < MAX_SIZE, 'File too large', 'file.size');
 * ```
 */
export function assert(
  condition: unknown,
  message: string,
  field?: string,
): asserts condition {
  if (!condition) {
    throw new ValidationError(message, field);
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
 *   { maxAttempts: 3, delay: 1000 }
 * );
 * ```
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delay?: number;
    backoff?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {},
): Promise<T> {
  const { maxAttempts = 3, delay = 1000, backoff = 2, onRetry } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      const waitTime = delay * Math.pow(backoff, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw lastError!;
}