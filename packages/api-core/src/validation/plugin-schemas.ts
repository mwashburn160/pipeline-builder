// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, VisibilitySchema, CatalogMetadataShape } from './common-schemas.js';
import { PluginCatalogEditsSchema } from './plugin-catalog-metadata.js';
import { PUBLISHER_HANDLE_PATTERN } from '../types/ecosystem.js';

/**
 * Plugin filter schema for query parameters
 */
export const PluginFilterSchema = BaseFilterSchema.extend({
  name: z.string().min(1).optional(),
  /** Resolve through this publisher's installed listing; lookup only. */
  publisher: z.string().max(39).regex(PUBLISHER_HANDLE_PATTERN).optional(),
  version: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
  pluginType: z.string().optional(),
  keyword: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
});

/**
 * Plugin creation schema — used for OpenAPI documentation and direct API creation.
 * Currently no route uses this directly; plugins are created via upload or AI generation.
 * Retained for future direct-create endpoint and OpenAPI spec completeness.
 */
export const PluginCreateSchema = z.object({
  ...CatalogMetadataShape,
  orgId: z.string().min(1, 'Organization ID is required'),
  name: z.string().min(1, 'Plugin name is required'),
  version: z.string().min(1, 'Version is required'),
  visibility: VisibilitySchema.optional(),
  category: z.string().min(1).optional(),
  pluginType: z.string().optional(),
  computeType: z.string().optional(),
  primaryOutputDirectory: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  buildArgs: z.record(z.string(), z.string()).optional(),
  installCommands: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  timeout: z.number().int().positive().nullable().optional(),
  failureBehavior: z.enum(['fail', 'warn', 'ignore']).optional(),
  secrets: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean(),
    description: z.string().optional(),
  })).optional(),
});

/**
 * Plugin update schema (`PUT /plugins/:id`).
 *
 * DESCRIPTIVE catalog fields only plus the version's operational
 * flags and developer-portal metadata. Execution-contract keys (commands, env,
 * secrets, compute type, …) are never accepted — the route refuses them with a
 * 400 naming the keys before this schema runs, and `.strict()` refuses anything
 * else unknown rather than silently dropping it.
 */
export const PluginUpdateSchema = z.object({
  ...CatalogMetadataShape,
  ...PluginCatalogEditsSchema.shape,
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  visibility: VisibilitySchema.optional(),
}).strict();

/**
 * Plugin upload body schema (multipart form-data text fields)
 */
export const PluginUploadBodySchema = z.object({
  visibility: VisibilitySchema.optional(),
  /**
   * Catalog metadata edits as a JSON object (a {@link PluginCatalogEditsSchema}
   * document). Absent ⇒ every value detected from the package is accepted.
   */
  metadata: z.string().max(256 * 1024).optional(),
  /**
   * `true`: once the build completes, submit a publish request (new listing, or
   * new version of the org's existing listing) for the built version as the
   * uploader (docs/plugin-publishing.md). Needs `plugins:publish` and
   * `visibility=public`. The Official catalog loader always sets it.
   */
  publishRequest: z.enum(['true', 'false']).optional(),
});
