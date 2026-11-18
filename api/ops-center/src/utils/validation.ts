// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendError } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import type { z } from 'zod';

/**
 * Validate data against a Zod schema.
 * Returns parsed value or null (sends 400 response on failure).
 *
 * Note: the "side-effect-on-fail + return null" pattern (writing the 400
 * directly to `res` and signaling failure with `null`) is unusual — most
 * validation helpers throw and let an error middleware translate. We keep
 * it because every controller in this service uses the
 *   `const body = validateBody(...); if (!body) return;`
 * idiom; switching to throws would touch every consumer for no real win.
 * If/when controllers move to a centralized error wrapper, swap this for
 * `validateBodyOrThrow`.
 */
export function validateBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  res: Response,
  /** Error code per top-level field, for a route whose clients branch on it
   *  (default `VALIDATION_ERROR`). */
  codes?: Record<string, string>,
): T | null {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const firstIssue = result.error.issues[0];
  const message = firstIssue
    ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
    : 'Validation failed';
  const code = (firstIssue && codes?.[String(firstIssue.path[0])]) || 'VALIDATION_ERROR';
  sendError(res, 400, message, code);
  return null;
}
