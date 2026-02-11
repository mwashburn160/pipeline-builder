/**
 * @module helpers/pipeline-helpers
 * @description Shared domain logic for pipeline operations.
 *
 * Centralises update-data building, pagination, sorting, record
 * normalization, and standardised error responses.
 */

import {
  normalizeArrayFields,
  createOrderByResolver,
  sendEntityNotFound,
  initUpdateData,
  validateAccessModifier,
  validateQuery,
  PipelineFilterSchema,
  ValidationResult,
} from '@mwashburn160/api-core';
import { schema, BuilderProps } from '@mwashburn160/pipeline-core';
import { asc, desc } from 'drizzle-orm';
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
// Update data builder
// ---------------------------------------------------------------------------

/** Allowed fields for pipeline update requests. */
export interface PipelineUpdateBody {
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props?: BuilderProps;
  isActive?: boolean;
  isDefault?: boolean;
  accessModifier?: string;
}

/**
 * Build a safe update object from request body, allowing only
 * permitted fields and sanitising values.
 *
 * @returns `{ data, error }` — if `error` is set, respond 400
 */
export function buildUpdateData(
  body: PipelineUpdateBody,
  userId: string,
): { data: Record<string, unknown>; error?: string } {
  const data = initUpdateData(userId);

  if (body.pipelineName !== undefined) data.pipelineName = body.pipelineName;
  if (body.description !== undefined) data.description = body.description;
  if (body.keywords !== undefined) data.keywords = Array.isArray(body.keywords) ? body.keywords : [];
  if (body.props !== undefined) data.props = typeof body.props === 'object' ? body.props : {};
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  if (body.isDefault !== undefined) data.isDefault = Boolean(body.isDefault);

  if (body.accessModifier !== undefined) {
    const validation = validateAccessModifier(body.accessModifier);
    if (!validation.valid) {
      return { data, error: validation.error };
    }
    data.accessModifier = body.accessModifier;
  }

  return { data };
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const SORTABLE_COLUMNS = {
  id: schema.pipeline.id,
  project: schema.pipeline.project,
  organization: schema.pipeline.organization,
  pipelineName: schema.pipeline.pipelineName,
  createdAt: schema.pipeline.createdAt,
  updatedAt: schema.pipeline.updatedAt,
  isActive: schema.pipeline.isActive,
  isDefault: schema.pipeline.isDefault,
} as const;

/** Resolve a sort column + direction into a Drizzle `orderBy` clause. */
export const resolveOrderBy = createOrderByResolver(
  SORTABLE_COLUMNS,
  schema.pipeline.createdAt,
  asc,
  desc,
);

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
export function validateFilter(req: Request): ValidationResult<any> {
  return validateQuery(req, PipelineFilterSchema);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "pipeline not found" response. */
export function sendPipelineNotFound(res: Response): Response {
  return sendEntityNotFound(res, 'Pipeline');
}
