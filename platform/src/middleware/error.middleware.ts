import { Request, Response, NextFunction } from 'express';
import { HttpError } from '../types';
import { logger, ErrorCode } from '../utils';

/**
 * 404 Not Found handler
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    statusCode: 404,
    message: 'The requested resource could not be found',
    code: ErrorCode.NOT_FOUND,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Global error handler
 */
export function errorHandler(
  err: HttpError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  logger.error(`${req.method} ${req.originalUrl} - ${status}`, {
    message: err.message,
    stack: err.stack,
    code: err.code,
  });

  res.status(status).json({
    success: false,
    statusCode: status,
    message: isProduction && status === 500 ? 'Internal server error' : err.message,
    code: err.code || ErrorCode.INTERNAL_ERROR,
    timestamp: new Date().toISOString(),
    ...(!isProduction && err.stack && { stack: err.stack }),
  });
}
