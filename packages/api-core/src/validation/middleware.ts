/**
 * @module validation/middleware
 * @description Zod validation middleware and helpers for Express routes
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ErrorCode } from '../types/error-codes';
import { sendError } from '../utils/response';

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

/**
 * Express middleware factory for validating query parameters
 *
 * @param schema - Zod schema for validation
 * @returns Express middleware that validates and attaches parsed data to req.validatedQuery
 *
 * @example
 * ```typescript
 * router.get('/',
 *   validateQueryMiddleware(PipelineFilterSchema),
 *   async (req, res) => {
 *     const filter = req.validatedQuery; // Type-safe!
 *     // ...
 *   }
 * );
 * ```
 */
export function validateQueryMiddleware<T>(
  schema: ZodSchema<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = validateQuery(req, schema);
    if (!result.ok) {
      sendError(res, 400, result.error, ErrorCode.VALIDATION_ERROR);
      return;
    }

    req.validatedQuery = result.value;
    next();
  };
}

/**
 * Express middleware factory for validating request body
 *
 * @param schema - Zod schema for validation
 * @returns Express middleware that validates and attaches parsed data to req.validatedBody
 */
export function validateBodyMiddleware<T>(
  schema: ZodSchema<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = validateBody(req, schema);
    if (!result.ok) {
      sendError(res, 400, result.error, ErrorCode.VALIDATION_ERROR);
      return;
    }

    req.validatedBody = result.value;
    next();
  };
}

/**
 * Express middleware factory for validating path parameters
 *
 * @param schema - Zod schema for validation
 * @returns Express middleware that validates and attaches parsed data to req.validatedParams
 */
export function validateParamsMiddleware<T>(
  schema: ZodSchema<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = validateParams(req, schema);
    if (!result.ok) {
      sendError(res, 400, result.error, ErrorCode.VALIDATION_ERROR);
      return;
    }

    req.validatedParams = result.value;
    next();
  };
}

/**
 * Augment Express Request type to include validated data
 */
declare global {
  namespace Express {
    interface Request {
      /** Validated query parameters (set by validateQueryMiddleware) */
      validatedQuery?: unknown;
      /** Validated request body (set by validateBodyMiddleware) */
      validatedBody?: unknown;
      /** Validated path parameters (set by validateParamsMiddleware) */
      validatedParams?: unknown;
    }
  }
}
