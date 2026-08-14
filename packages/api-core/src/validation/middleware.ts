// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Result type for validation operations.
 *
 * CANONICAL validation-result shape for the api-core public surface: a boolean-
 * discriminated union (`if (!result.ok) …`). Use THIS for anything that parses
 * against a Zod schema — `validate` / `validateBody` / `validateQuery`. The
 * `ok` discriminant also carries the optional `zodError` for callers that want
 * field-level detail.
 *
 * Note the deliberately-lighter sibling shape in `utils/params.ts`
 * (`{ value } | { error }`, narrowed with `'error' in result`). That one is for
 * simple inline request-parsing guards (`validateBulkArray`, `parseDateRange`,
 * `parseReportInterval`) — NOT schema validation. The two are kept distinct on
 * purpose: unifying `utils/params.ts` onto `{ ok }` would touch every
 * `'error' in result` call site across the downstream services (pipeline,
 * plugin, reporting, compliance, …) for no behavioural gain, so the convention
 * is documented rather than force-migrated. Rule of thumb: Zod schema →
 * `ValidationResult` (`ok`); ad-hoc parse guard → params.ts (`'error' in`).
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; zodError?: ZodError };

/**
 * Validate arbitrary data against a Zod schema.
 *
 * This is the core validation function used by the Express-specific helpers
 * (`validateBody`, `validateQuery`). It can also be called directly when
 * validating data that doesn't come from a request object.
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
