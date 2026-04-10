// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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

/**
 * Typed API error with status, response, and Axios compatibility flag.
 * Replaces `as any` casts in api-client.ts error handling.
 */
export class ApiError extends Error implements AxiosErrorLike {
  public readonly isAxiosError = true as const;

  constructor(
    message: string,
    public status: number,
    public response: AxiosErrorLike['response'],
  ) {
    super(message);
    this.name = 'ApiError';
    Error.captureStackTrace(this, this.constructor);
  }
}
