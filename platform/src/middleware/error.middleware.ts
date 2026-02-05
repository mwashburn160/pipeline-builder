/**
 * @module middleware/error
 * @description Global error handling middleware for Express application.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils';

/**
 * Handle requests to non-existent routes.
 *
 * @param _req - Express request object (unused)
 * @param res - Express response object
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    statusCode: 404,
    message: 'The requested resource could not be found',
  });
}

/**
 * Global error handler for uncaught errors in route handlers.
 * Logs error details and returns a standardized error response.
 * Stack traces are only included in development mode.
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
  const isDevelopment = process.env.NODE_ENV === 'development';

  logger.error(`${req.method} ${req.originalUrl} - ${status}`, {
    message: err.message,
    stack: err.stack,
  });

  res.status(status).json({
    success: false,
    statusCode: status,
    message: err.message,
    ...(isDevelopment && { stack: err.stack }),
  });
}
