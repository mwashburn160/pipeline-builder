// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, ErrorCode } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('platform-api');

/**
 * Handle requests to non-existent routes.
 *
 * @param _req - Express request object (unused)
 * @param res - Express response object
 */
export function notFoundHandler(_req: Request, res: Response): void {
  sendError(res, 404, 'The requested resource could not be found', ErrorCode.NOT_FOUND);
}

/** The `ErrorCode` a 4xx status answers with, so clients see a consistent
 *  machine-readable code alongside the human message. Any other 4xx reads as a
 *  validation error. */
const CLIENT_ERROR_CODES: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.INSUFFICIENT_PERMISSIONS,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  429: ErrorCode.RATE_LIMIT_EXCEEDED,
};

function pickClientErrorCode(status: number): ErrorCode {
  return CLIENT_ERROR_CODES[status] ?? ErrorCode.VALIDATION_ERROR;
}

/**
 * Global error handler for uncaught errors in route handlers.
 * Logs error details and returns a standardized error response.
 *
 * @param err - Error object with optional status code
 * @param req - Express request object
 * @param res - Express response object
 * @param _next - Express next function (unused, required for error handler signature)
 */
export function errorHandler(
  err: Error & { status?: number },
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status || 500;

  logger.error(`${req.method} ${req.originalUrl} - ${status}`, {
    message: err.message,
    stack: err.stack,
  });

  // 5xx errors must NEVER leak `err.message` to clients — the message can
  // contain internal-state info (file paths, query fragments, secrets in
  // bad-config messages). Log the real details above; respond generically.
  if (status >= 500) {
    return sendError(res, status, 'Internal server error', ErrorCode.INTERNAL_ERROR);
  }

  // 4xx: client-visible. Pick a code keyed on the status so clients can
  // branch on it instead of parsing the human message.
  sendError(res, status, err.message, pickClientErrorCode(status));
}
