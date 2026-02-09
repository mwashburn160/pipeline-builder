/**
 * @module helpers/pipeline-helpers
 * @description Shared domain logic for pipeline operations.
 *
 * Centralises update-data building, pagination, sorting, record
 * normalization, and standardised error responses.
 */

import { ErrorCode } from '@mwashburn160/api-core';
import { schema, validatePipelineFilter, BuilderProps, PipelineFilter } from '@mwashburn160/pipeline-core';
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
  return {
    ...record,
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
  };
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
  const data: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: userId || 'system',
  };

  if (body.pipelineName !== undefined) data.pipelineName = body.pipelineName;
  if (body.description !== undefined) data.description = body.description;
  if (body.keywords !== undefined) data.keywords = Array.isArray(body.keywords) ? body.keywords : [];
  if (body.props !== undefined) data.props = typeof body.props === 'object' ? body.props : {};
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  if (body.isDefault !== undefined) data.isDefault = Boolean(body.isDefault);

  if (body.accessModifier !== undefined) {
    if (!['public', 'private'].includes(body.accessModifier)) {
      return { data, error: 'accessModifier must be "public" or "private"' };
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

type SortableColumn = keyof typeof SORTABLE_COLUMNS;

/** Resolve a sort column + direction into a Drizzle `orderBy` clause. */
export function resolveOrderBy(sortBy: string, sortOrder: 'asc' | 'desc') {
  const column = SORTABLE_COLUMNS[sortBy as SortableColumn] ?? schema.pipeline.createdAt;
  return (sortOrder === 'asc' ? asc : desc)(column);
}

// ---------------------------------------------------------------------------
// Filter validation
// ---------------------------------------------------------------------------

type FilterResult =
  | { ok: true; value: Partial<PipelineFilter> }
  | { ok: false; error: string };

/** Validate pipeline filter params from query string. */
export function validateFilter(req: Request): FilterResult {
  const filter = req.query as unknown as Partial<PipelineFilter>;
  try {
    validatePipelineFilter(filter as PipelineFilter);
    return { ok: true, value: filter };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid filter' };
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Send a 404 "pipeline not found" response. */
export function sendPipelineNotFound(res: Response): Response {
  return res.status(404).json({ success: false, statusCode: 404, message: 'Pipeline not found.', code: ErrorCode.NOT_FOUND });
}
