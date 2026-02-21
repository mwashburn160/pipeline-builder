/**
 * @module helpers/pipeline-helpers
 * @description Shared domain logic for pipeline operations.
 *
 * Centralises update-data building, pagination, sorting, record
 * normalization, and standardised error responses.
 */

import {
  normalizeArrayFields,
  sendEntityNotFound,
  validateQuery,
  PipelineFilterSchema,
  type ValidatedPipelineFilter,
  type ValidationResult,
} from '@mwashburn160/api-core';
import { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a pipeline record from the database before returning to clients.
 * Ensures jsonb array fields are always arrays (guards against bad data).
 */
export function normalizePipeline<T extends Record<string, unknown>>(record: T): T {
  return normalizeArrayFields(record, ['keywords']);
}

// ---------------------------------------------------------------------------
// Filter validation (Zod-based)
// ---------------------------------------------------------------------------

/**
 * Validate pipeline filter params from query string using Zod schema.
 * Provides runtime type-safe validation with automatic type coercion.
 *
 * @param req - Express request with query parameters
 * @returns Validation result with parsed filter or error message
 */
export function validateFilter(req: Request): ValidationResult<ValidatedPipelineFilter> {
  return validateQuery(req, PipelineFilterSchema);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "pipeline not found" response. */
export function sendPipelineNotFound(res: Response): Response {
  return sendEntityNotFound(res, 'Pipeline');
}
