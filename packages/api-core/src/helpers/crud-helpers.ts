import type { Request, Response } from 'express';
import { ErrorCode } from '../types/error-codes';

/**
 * Generic record normalizer - ensures array fields are always arrays
 * @param record - The record to normalize
 * @param arrayFields - Fields that should be arrays
 * @returns Normalized record with array fields guaranteed to be arrays
 */
export function normalizeArrayFields<T extends Record<string, unknown>>(
  record: T,
  arrayFields: (keyof T)[],
): T {
  const normalized = { ...record };
  for (const field of arrayFields) {
    if (field in normalized && !Array.isArray(normalized[field])) {
      (normalized as Record<string, unknown>)[field as string] = [];
    }
  }
  return normalized;
}

/**
 * Type for sort functions (e.g., from Drizzle: asc/desc).
 * Uses `unknown` because this bridges framework-agnostic code with ORM-specific
 * column types (e.g., Drizzle's SQLWrapper | AnyColumn) that api-core
 * does not depend on.
 */
export type SortFunction = (column: unknown) => unknown;

/**
 * Generic order-by resolver for database queries
 * Creates a function that resolves sort column and direction
 * @param columns - Map of sortable column names to column objects
 * @param defaultColumn - Default column to sort by if sortBy is invalid
 * @param ascFn - Ascending sort function (e.g., drizzle asc)
 * @param descFn - Descending sort function (e.g., drizzle desc)
 * @returns Function that returns sort expression
 */
export function createOrderByResolver<TColumns extends Record<string, unknown>>(
  columns: TColumns,
  defaultColumn: unknown,
  ascFn: SortFunction,
  descFn: SortFunction,
) {
  return (sortBy: string, sortOrder: 'asc' | 'desc') => {
    const column = columns[sortBy] ?? defaultColumn;
    return (sortOrder === 'asc' ? ascFn : descFn)(column);
  };
}

/**
 * Result type for filter validation operations
 */
export type FilterResult<T> =
  | { ok: true; value: Partial<T> }
  | { ok: false; error: string };

/**
 * Generic filter validator with Result type pattern
 * Validates request query parameters using provided validator function
 * @param req - Express request object
 * @param validator - Validation function that throws on invalid filter
 * @returns FilterResult with parsed filter or error message
 */
export function validateRequestFilter<TFilter>(
  req: Request,
  validator: (filter: TFilter) => void,
): FilterResult<TFilter> {
  const filter = req.query as unknown as Partial<TFilter>;
  try {
    validator(filter as TFilter);
    return { ok: true, value: filter };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid filter' };
  }
}

/**
 * Generic entity not-found response
 * Sends standardized 404 response for missing entities
 * @param res - Express response object
 * @param entityName - Name of the entity type (e.g., "Pipeline", "Plugin")
 * @returns Express response
 */
export function sendEntityNotFound(res: Response, entityName: string): Response {
  return res.status(404).json({
    success: false,
    statusCode: 404,
    message: `${entityName} not found.`,
    code: ErrorCode.NOT_FOUND,
  });
}

/**
 * Common update data initialization
 * Creates base update object with timestamp and user tracking
 * @param userId - ID of user performing the update
 * @returns Record with updatedAt and updatedBy fields
 */
export function initUpdateData(userId: string): Record<string, unknown> {
  return {
    updatedAt: new Date(),
    updatedBy: userId || 'system',
  };
}

/**
 * Validation result for accessModifier field
 */
export type AccessModifierValidation =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Validate accessModifier field value
 * Ensures value is either "public" or "private"
 * @param value - Value to validate
 * @returns Validation result
 */
export function validateAccessModifier(
  value: unknown,
): AccessModifierValidation {
  if (!['public', 'private'].includes(value as string)) {
    return { valid: false, error: 'accessModifier must be "public" or "private"' };
  }
  return { valid: true };
}
