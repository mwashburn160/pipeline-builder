/**
 * @module validation/middleware
 * @description Zod validation helpers for Express routes
 */

import { Request } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Result type for validation operations
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; zodError?: ZodError };

/**
 * Validate request query parameters with a Zod schema
 *
 * @param req - Express request
 * @param schema - Zod schema for validation
 * @returns Validation result with parsed data or error
 *
 * @example
 * ```typescript
 * const result = validateQuery(req, PipelineFilterSchema);
 * if (!result.ok) {
 *   return sendBadRequest(res, result.error);
 * }
 * const filter = result.value;
 * ```
 */
export function validateQuery<T>(
  req: Request,
  schema: ZodSchema<T>,
): ValidationResult<T> {
  try {
    const parsed = schema.parse(req.query);
    return { ok: true, value: parsed };
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      return { ok: false, error: message, zodError: error };
    }
    return { ok: false, error: 'Validation failed' };
  }
}

/**
 * Validate request body with a Zod schema
 *
 * @param req - Express request
 * @param schema - Zod schema for validation
 * @returns Validation result with parsed data or error
 *
 * @example
 * ```typescript
 * const result = validateBody(req, PipelineCreateSchema);
 * if (!result.ok) {
 *   return sendBadRequest(res, result.error);
 * }
 * const data = result.value;
 * ```
 */
export function validateBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): ValidationResult<T> {
  try {
    const parsed = schema.parse(req.body);
    return { ok: true, value: parsed };
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      return { ok: false, error: message, zodError: error };
    }
    return { ok: false, error: 'Validation failed' };
  }
}

/**
 * Validate request path parameters with a Zod schema
 *
 * @param req - Express request
 * @param schema - Zod schema for validation
 * @returns Validation result with parsed data or error
 */
export function validateParams<T>(
  req: Request,
  schema: ZodSchema<T>,
): ValidationResult<T> {
  try {
    const parsed = schema.parse(req.params);
    return { ok: true, value: parsed };
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      return { ok: false, error: message, zodError: error };
    }
    return { ok: false, error: 'Validation failed' };
  }
}
