import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import {
  ERROR_CODES,
  ErrorCode,
  ErrorHandlerOptions,
  ValidationErrorDetails,
  NetworkErrorDetails,
  AxiosErrorLike,
} from '../types';

const { bold, dim, red, yellow, cyan } = pico;

// Re-export for convenience
export { ERROR_CODES };
export type { ErrorCode };

/**
 * Format and handle errors with colored output
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

    if (err instanceof Error) {
      console.error(red(bold('Message:')), err.message);

      if (err.name !== 'Error') {
        console.error(red('Type:'), err.name);
      }

      // Show Validation error details
      if (err instanceof ValidationError) {
        if (err.field) console.error(red('Field:'), err.field);
        if (err.value !== undefined) console.error(red('Value:'), sanitizeValue(err.value));
        if (err.rule) console.error(red('Rule:'), err.rule);
        if (err.expected) console.error(red('Expected:'), err.expected);
      }

      // Show Network error details
      if (err instanceof NetworkError) {
        if (err.url) console.error(red('URL:'), sanitizeUrl(err.url));
        if (err.timeout) console.error(red('Timeout:'), `${err.timeout}ms`);
        console.error(red('Request Made:'), err.requestMade ? 'Yes' : 'No');
        console.error(red('Response Received:'), err.responseReceived ? 'Yes' : 'No');
        if (err.cause) console.error(red('Caused by:'), err.cause.message);
      }

      // Show Axios error details
      if (isAxiosError(err)) {
        const status = err.response?.status;
        const url = err.config?.url;
        if (status) {
          console.error(red('Status:'), status);
          console.error(red('Status Text:'), getHttpStatusText(status));
        }
        if (url) console.error(red('URL:'), sanitizeUrl(url));
        if (err.response?.data) {
          console.error(red('Response:'));
          console.error(dim(sanitizeErrorData(err.response.data)));
        }
      }

      console.error(red('Code:'), getErrorCodeName(code));
      console.error(dim('Error ID:'), dim(errorId));

      if (context && Object.keys(context).length > 0) {
        console.error('');
        console.error(red('Context:'));
        Object.entries(context).forEach(([key, value]) => {
          console.error(`  ${cyan(key)}:`, dim(sanitizeContextValue(value)));
        });
      }

      if (debug && err.stack) {
        console.error('');
        console.error(dim('Stack trace:'));
        console.error(dim(sanitizeStackTrace(err.stack)));
      }
    } else {
      console.error(red('Error:'), String(err));
      console.error(red('Code:'), getErrorCodeName(code));
      console.error(dim('Error ID:'), dim(errorId));
    }

    console.error(dim(divider));

    if (!debug) {
      console.error(yellow('💡 Tip:'), dim('Run with --debug flag to see full stack trace'));
    }

    const suggestion = getErrorSuggestion(err, code);
    if (suggestion) {
      console.error(yellow('💡 Suggestion:'), dim(suggestion));
    }

    console.error('');
  }

  if (exit) {
    process.exitCode = code;
    process.exit(code);
  }

  throw err;
}

// --- Error classes (only those actually used) ---

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

// --- Private helpers ---

function getErrorCodeName(code: ErrorCode): string {
  const entry = Object.entries(ERROR_CODES).find(([_, value]) => value === code);
  return entry ? `${entry[0]} (${code})` : String(code);
}

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
    if (status === 401 || status === 403) return 'Check your authentication token and permissions';
    if (status === 429) return 'Rate limit exceeded - wait a moment before retrying';
    if (status && status >= 500) return 'Server error - try again later or contact support';
  }
  return null;
}

function sanitizeErrorData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    const sanitized = { ...data } as any;
    ['token', 'password', 'secret', 'apiKey', 'authorization'].forEach(field => {
      if (field in sanitized) sanitized[field] = '[REDACTED]';
    });
    return JSON.stringify(sanitized, null, 2);
  }
  return String(data);
}

function sanitizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    ['token', 'key', 'secret', 'password', 'apiKey'].forEach(param => {
      if (urlObj.searchParams.has(param)) urlObj.searchParams.set(param, '[REDACTED]');
    });
    return urlObj.toString();
  } catch {
    return url;
  }
}

function sanitizeContextValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') {
    if (value.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return `${value.substring(0, 8)}...[REDACTED]`;
    }
    return value;
  }
  if (typeof value === 'object') return sanitizeErrorData(value);
  return JSON.stringify(value);
}

const MAX_STACK_FRAMES = 10;

function sanitizeStackTrace(stack: string): string {
  return stack
    .split('\n')
    .slice(0, MAX_STACK_FRAMES)
    .map(line => line.replace(/\/.*?\//g, '.../'))
    .join('\n');
}

function sanitizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return str.length > 100 ? str.substring(0, 97) + '...' : str;
}

function isAxiosError(err: unknown): err is AxiosErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'isAxiosError' in err &&
    (err as any).isAxiosError === true
  );
}
