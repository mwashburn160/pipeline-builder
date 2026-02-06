/**
 * @module helpers/plugin-helpers
 * @description Shared domain logic for plugin operations.
 *
 * Centralises update-data building, pagination, sorting, record
 * normalization, and standardised error responses.
 */

import {
  schema,
  ErrorCode,
  validatePluginFilter,
} from '@mwashburn160/pipeline-core';
import type { PluginFilter } from '@mwashburn160/pipeline-core';
import { asc, desc } from 'drizzle-orm';
import { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a plugin record from the database before returning to clients.
 * Ensures jsonb array fields are always arrays (guards against bad data).
 */
export function normalizePlugin<T extends Record<string, unknown>>(record: T): T {
  return {
    ...record,
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
    installCommands: Array.isArray(record.installCommands) ? record.installCommands : [],
    commands: Array.isArray(record.commands) ? record.commands : [],
  };
}

// ---------------------------------------------------------------------------
// Update data builder
// ---------------------------------------------------------------------------

/** Allowed fields for plugin update requests. */
export interface PluginUpdateBody {
  name?: string;
  description?: string;
  keywords?: string[];
  version?: string;
  metadata?: Record<string, unknown>;
  pluginType?: string;
  computeType?: string;
  env?: Record<string, string>;
  installCommands?: string[];
  commands?: string[];
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
  body: PluginUpdateBody,
  userId: string,
): { data: Record<string, unknown>; error?: string } {
  const data: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: userId || 'system',
  };

  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  if (body.keywords !== undefined) data.keywords = Array.isArray(body.keywords) ? body.keywords : [];
  if (body.version !== undefined) data.version = body.version;

  if (body.metadata !== undefined) data.metadata = typeof body.metadata === 'object' ? body.metadata : {};
  if (body.pluginType !== undefined) data.pluginType = body.pluginType;
  if (body.computeType !== undefined) data.computeType = body.computeType;

  if (body.env !== undefined) data.env = typeof body.env === 'object' ? body.env : {};
  if (body.installCommands !== undefined) data.installCommands = Array.isArray(body.installCommands) ? body.installCommands : [];
  if (body.commands !== undefined) data.commands = Array.isArray(body.commands) ? body.commands : [];

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
// Pagination + sorting
// ---------------------------------------------------------------------------

export interface PaginationParams {
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}

/** Parse pagination/sort params from query string, clamping to safe defaults. */
export function parsePaginationParams(query: Record<string, unknown>): PaginationParams {
  const limit = Math.min(Math.max(parseInt(String(query.limit), 10) || 10, 1), 100);
  const offset = Math.max(parseInt(String(query.offset), 10) || 0, 0);
  const sortBy = String(query.sortBy || 'createdAt');
  const sortOrder: 'asc' | 'desc' =
    String(query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  return { limit, offset, sortBy, sortOrder };
}

const SORTABLE_COLUMNS = {
  id: schema.plugin.id,
  name: schema.plugin.name,
  version: schema.plugin.version,
  createdAt: schema.plugin.createdAt,
  updatedAt: schema.plugin.updatedAt,
  isActive: schema.plugin.isActive,
  isDefault: schema.plugin.isDefault,
} as const;

type SortableColumn = keyof typeof SORTABLE_COLUMNS;

/** Resolve a sort column + direction into a Drizzle `orderBy` clause. */
export function resolveOrderBy(sortBy: string, sortOrder: 'asc' | 'desc') {
  const column = SORTABLE_COLUMNS[sortBy as SortableColumn] ?? schema.plugin.createdAt;
  return (sortOrder === 'asc' ? asc : desc)(column);
}

// ---------------------------------------------------------------------------
// Filter validation
// ---------------------------------------------------------------------------

type FilterResult =
  | { ok: true; value: Partial<PluginFilter> }
  | { ok: false; error: string };

/** Validate plugin filter params from query string. */
export function validateFilter(req: Request): FilterResult {
  const filter = req.query as unknown as Partial<PluginFilter>;
  try {
    validatePluginFilter(filter as PluginFilter);
    return { ok: true, value: filter };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid filter' };
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/** Extract a message string from an unknown catch value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Send a 400 bad-request response. */
export function sendBadRequest(res: Response, message: string, code = ErrorCode.VALIDATION_ERROR): Response {
  return res.status(400).json({ success: false, statusCode: 400, message, code });
}

/** Send a 404 "plugin not found" response. */
export function sendPluginNotFound(res: Response): Response {
  return res.status(404).json({ success: false, statusCode: 404, message: 'Plugin not found.', code: ErrorCode.NOT_FOUND });
}

/** Send a 500 internal error response. */
export function sendInternalError(res: Response, message: string, details?: Record<string, unknown>): Response {
  return res.status(500).json({ success: false, statusCode: 500, message, code: ErrorCode.INTERNAL_ERROR, ...details });
}
