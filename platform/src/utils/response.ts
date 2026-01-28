import { Response } from 'express';

/**
 * Standard error response
 */
export interface ErrorResponse {
  success: false;
  message: string;
  code?: string;
}

/**
 * Standard success response
 */
export interface SuccessResponse<T = unknown> {
  success: true;
  message?: string;
  data?: T;
}

/**
 * Send error response
 */
export function sendError(
  res: Response,
  status: number,
  message: string,
  code?: string,
): void {
  res.status(status).json({
    success: false,
    message,
    ...(code && { code }),
  } as ErrorResponse);
}

/**
 * Send 401 Unauthorized response
 */
export function sendUnauthorized(
  res: Response,
  message: string = 'Unauthorized',
  code?: string,
): void {
  sendError(res, 401, message, code);
}

/**
 * Send 403 Forbidden response
 */
export function sendForbidden(
  res: Response,
  message: string = 'Forbidden',
  code?: string,
): void {
  sendError(res, 403, message, code);
}

/**
 * Send 404 Not Found response
 */
export function sendNotFound(
  res: Response,
  message: string = 'Not found',
  code?: string,
): void {
  sendError(res, 404, message, code);
}

/**
 * Send success response
 */
export function sendSuccess<T>(
  res: Response,
  data?: T,
  message?: string,
  status: number = 200,
): void {
  res.status(status).json({
    success: true,
    ...(message && { message }),
    ...(data !== undefined && { data }),
  } as SuccessResponse<T>);
}
