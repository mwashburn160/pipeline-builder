/**
 * @module helpers/plugin-helpers
 * @description Shared domain logic for plugin operations.
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
  PluginFilterSchema,
  type ValidatedPluginFilter,
  type ValidationResult,
} from '@mwashburn160/api-core';
import { schema } from '@mwashburn160/pipeline-core';
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
  return normalizeArrayFields(record, ['keywords', 'installCommands', 'commands']);
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
  primaryOutputDirectory?: string | null;
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
  const data = initUpdateData(userId);

  if (body.name !== undefined) data.name = body.name;
  if (body.description !== undefined) data.description = body.description;
  if (body.keywords !== undefined) data.keywords = Array.isArray(body.keywords) ? body.keywords : [];
  if (body.version !== undefined) data.version = body.version;

  if (body.metadata !== undefined) data.metadata = (typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata)) ? body.metadata : {};
  if (body.pluginType !== undefined) data.pluginType = body.pluginType;
  if (body.computeType !== undefined) data.computeType = body.computeType;
  if (body.primaryOutputDirectory !== undefined) data.primaryOutputDirectory = body.primaryOutputDirectory;

  if (body.env !== undefined) data.env = (typeof body.env === 'object' && body.env !== null && !Array.isArray(body.env)) ? body.env : {};
  if (body.installCommands !== undefined) data.installCommands = Array.isArray(body.installCommands) ? body.installCommands : [];
  if (body.commands !== undefined) data.commands = Array.isArray(body.commands) ? body.commands : [];

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
  id: schema.plugin.id,
  name: schema.plugin.name,
  version: schema.plugin.version,
  createdAt: schema.plugin.createdAt,
  updatedAt: schema.plugin.updatedAt,
  isActive: schema.plugin.isActive,
  isDefault: schema.plugin.isDefault,
} as const;

/** Resolve a sort column + direction into a Drizzle `orderBy` clause. */
export const resolveOrderBy = createOrderByResolver(
  SORTABLE_COLUMNS,
  schema.plugin.createdAt,
  asc,
  desc,
);

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
