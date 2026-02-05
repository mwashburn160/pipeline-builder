/**
 * @module utils/response
 * @description Standardized HTTP response helpers for consistent API responses.
 */

import { Response } from 'express';

/**
 * Standard error response structure.
 */
export interface ErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  code?: string;
}

/**
 * Standard success response structure.
 * @template T - Type of the data payload
 */
export interface SuccessResponse<T = unknown> {
  success: true;
  statusCode: number;
  message?: string;
  data?: T;
}

/**
 * Send a standardized error response.
 *
 * @param res - Express response object
 * @param status - HTTP status code
 * @param message - Error message
 * @param code - Optional error code for client handling
 */
export function sendError(
  res: Response,
  status: number,
  message: string,
  code?: string,
): void {
  res.status(status).json({
    success: false,
    statusCode: status,
    message,
    ...(code && { code }),
  } as ErrorResponse);
}

/**
 * Send a 401 Unauthorized response.
 *
 * @param res - Express response object
 * @param message - Error message (default: 'Unauthorized')
 * @param code - Optional error code
 */
export function sendUnauthorized(
  res: Response,
  message: string = 'Unauthorized',
  code?: string,
): void {
  sendError(res, 401, message, code);
}

/**
 * Send a 403 Forbidden response.
 *
 * @param res - Express response object
 * @param message - Error message (default: 'Forbidden')
 * @param code - Optional error code
 */
export function sendForbidden(
  res: Response,
  message: string = 'Forbidden',
  code?: string,
): void {
  sendError(res, 403, message, code);
}

/**
 * Send a 404 Not Found response.
 *
 * @param res - Express response object
 * @param message - Error message (default: 'Not found')
 * @param code - Optional error code
 */
export function sendNotFound(
  res: Response,
  message: string = 'Not found',
  code?: string,
): void {
  sendError(res, 404, message, code);
}

/**
 * Send a standardized success response.
 *
 * @template T - Type of the data payload
 * @param res - Express response object
 * @param data - Response data payload
 * @param message - Optional success message
 * @param status - HTTP status code (default: 200)
 */
export function sendSuccess<T>(
  res: Response,
  data?: T,
  message?: string,
  status: number = 200,
): void {
  res.status(status).json({
    success: true,
    statusCode: status,
    ...(message && { message }),
    ...(data !== undefined && { data }),
  } as SuccessResponse<T>);
}
