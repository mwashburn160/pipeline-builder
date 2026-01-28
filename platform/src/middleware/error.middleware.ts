import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../utils';

/**
 * 404 Not Found handler
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource could not be found',
  });
}

/**
 * Global error handler
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status || 500;
  const isProduction = config.app.env === 'production';

  logger.error(`${req.method} ${req.originalUrl} - ${status}`, {
    message: err.message,
    stack: isProduction ? undefined : err.stack,
  });

  res.status(status).json({
    success: false,
    error: isProduction
      ? status >= 500
        ? 'Internal Server Error'
        : 'An error occurred'
      : err.message,
    ...(! isProduction && { stack: err.stack }),
  });
}
