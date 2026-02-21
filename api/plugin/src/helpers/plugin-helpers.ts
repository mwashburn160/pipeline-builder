/**
 * @module helpers/plugin-helpers
 * @description Shared domain logic for plugin operations.
 *
 * Centralises update-data building, pagination, sorting, record
 * normalization, and standardised error responses.
 */

import {
  normalizeArrayFields,
  sendEntityNotFound,
  validateQuery,
  PluginFilterSchema,
  type ValidatedPluginFilter,
  type ValidationResult,
} from '@mwashburn160/api-core';
import { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a plugin record from the database before returning to clients.
 * Ensures jsonb array fields are always arrays (guards against bad data).
 */
export function normalizePlugin<T extends Record<string, unknown>>(record: T): T {
  return normalizeArrayFields(record, ['keywords', 'installCommands', 'commands']);
}

// ---------------------------------------------------------------------------
// Filter validation (Zod-based)
// ---------------------------------------------------------------------------

/**
 * Validate plugin filter params from query string using Zod schema.
 * Provides runtime type-safe validation with automatic type coercion.
 *
 * @param req - Express request with query parameters
 * @returns Validation result with parsed filter or error message
 */
export function validateFilter(req: Request): ValidationResult<ValidatedPluginFilter> {
  return validateQuery(req, PluginFilterSchema);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "plugin not found" response. */
export function sendPluginNotFound(res: Response): Response {
  return sendEntityNotFound(res, 'Plugin');
}
