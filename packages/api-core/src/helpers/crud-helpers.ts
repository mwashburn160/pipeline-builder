import type { Response } from 'express';
import { ErrorCode } from '../types/error-codes';
import { sendError } from '../utils/response';

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
 * Generic entity not-found response
 * Sends standardized 404 response for missing entities
 * @param res - Express response object
 * @param entityName - Name of the entity type (e.g., "Pipeline", "Plugin")
 * @returns Express response
 */
export function sendEntityNotFound(res: Response, entityName: string): void {
  sendError(res, 404, `${entityName} not found.`, ErrorCode.NOT_FOUND);
}
