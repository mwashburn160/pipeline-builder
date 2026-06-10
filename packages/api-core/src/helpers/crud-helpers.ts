// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Response } from 'express';
import { ErrorCode } from '../types/error-codes.js';
import { sendError } from '../utils/response.js';

/**
 * Coerce listed fields on a DB-returned record to arrays. Drizzle/pg sometimes
 * returns `null` for jsonb columns when the row was inserted with a missing
 * key — callers expect `[]` so map iteration doesn't crash.
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

/** Send a 404 NOT_FOUND error with a standard `${entityName} not found.` message. */
export function sendEntityNotFound(res: Response, entityName: string): void {
  sendError(res, 404, `${entityName} not found.`, ErrorCode.NOT_FOUND);
}
