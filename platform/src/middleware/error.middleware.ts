/**
 * @module middleware/error
 * @description Global error handling middleware for Express application.
 */

import { createLogger, sendError, ErrorCode } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';

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

  sendError(res, status, err.message, ErrorCode.INTERNAL_ERROR);
}
