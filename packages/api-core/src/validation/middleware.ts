// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Request } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Result type for validation operations
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; zodError?: ZodError };

/**
 * Validate arbitrary data against a Zod schema.
 *
 * This is the core validation function used by the Express-specific helpers
 * (`validateBody`, `validateQuery`, `validateParams`). It can also be called
 * directly when validating data that doesn't come from a request object.
 *
 * @param data - Data to validate
 * @param schema - Zod schema for validation
 * @returns Validation result with parsed data or error
 *
 * @example
 * ```typescript
 * const result = validate(someData, MySchema);
 * if (!result.ok) {
 *   return sendBadRequest(res, result.error);
 * }
 * const parsed = result.value;
 * ```
 */
export function validate<T>(
  data: unknown,
  schema: ZodSchema<T>,
): ValidationResult<T> {
  try {
    return { ok: true, value: schema.parse(data) };
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
 * Validate request query parameters with a Zod schema.
 *
 * @example
 * ```typescript
 * const result = validateQuery(req, PipelineFilterSchema);
 * if (!result.ok) return sendBadRequest(res, result.error);
 * const filter = result.value;
 * ```
 */
export function validateQuery<T>(req: Request, schema: ZodSchema<T>): ValidationResult<T> {
  return validate(req.query, schema);
}

/**
 * Validate request body with a Zod schema.
 *
 * @example
 * ```typescript
 * const result = validateBody(req, PipelineCreateSchema);
 * if (!result.ok) return sendBadRequest(res, result.error);
 * const data = result.value;
 * ```
 */
export function validateBody<T>(req: Request, schema: ZodSchema<T>): ValidationResult<T> {
  return validate(req.body, schema);
}

/**
 * Validate request path parameters with a Zod schema.
 */
export function validateParams<T>(req: Request, schema: ZodSchema<T>): ValidationResult<T> {
  return validate(req.params, schema);
}
