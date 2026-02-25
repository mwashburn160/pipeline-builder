/**
 * @module helpers/message-helpers
 * @description Shared domain logic for message operations.
 *
 * Centralises filter validation and standardised error responses.
 */

import {
  sendEntityNotFound,
  validateQuery,
  MessageFilterSchema,
  type ValidatedMessageFilter,
  type ValidationResult,
} from '@mwashburn160/api-core';
import { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Filter validation (Zod-based)
// ---------------------------------------------------------------------------

/**
 * Validate message filter params from query string using Zod schema.
 * Provides runtime type-safe validation with automatic type coercion.
 *
 * @param req - Express request with query parameters
 * @returns Validation result with parsed filter or error message
 */
export function validateFilter(req: Request): ValidationResult<ValidatedMessageFilter> {
  return validateQuery(req, MessageFilterSchema);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "message not found" response. */
export function sendMessageNotFound(res: Response): Response {
  return sendEntityNotFound(res, 'Message');
}

/** Send a 404 "thread not found" response. */
export function sendThreadNotFound(res: Response): Response {
  return sendEntityNotFound(res, 'Thread');
}
