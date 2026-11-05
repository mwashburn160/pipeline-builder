// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, VisibilitySchema, CatalogMetadataShape } from './common-schemas.js';
import { PluginCatalogEditsSchema } from './plugin-catalog-metadata.js';
import { BUILD_CLASSES, BUILD_SIZES } from '../types/build-catalog.js';
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
  /**
   * `true`: this upload is the SETUP catalog load (deploy/bin/load-plugins.sh).
   * Honoured only for a system-org build, where an image the scan gates refuse
   * is KEPT in the registry for promotion (`POST /plugins/kept-setup-images/:id/promote`)
   * instead of discarded. Ignored (normal discard) for any other org.
   */
  setupLoad: z.enum(['true', 'false']).optional(),
  /**
   * Scheduling class for this build (D11). `standard` is the default and the
   * only class an urgent fix should use; `batch` trades start latency for more
   * per-org headroom, and every tier has both — a free account must still be
   * able to push one urgent build through.
   *
   * Not a BullMQ priority: priorities are per-queue integers and builds are
   * already split across one queue PER TIER, so a priority would only order a
   * tier against itself. The class is a job field the worker admits against,
   * which is where the contention actually is.
   */
  buildClass: z.enum(BUILD_CLASSES).optional(),
  /**
   * Machine size for this build (D13). Credit-neutral per build — a `2x` build
   * burns the same credits twice as fast — so this is a capability gate, not a
   * price: `TIER_BUILD_SIZES` says which tier may ask for which, and a request
   * above the tier's ceiling is refused rather than silently downgraded.
   */
  buildSize: z.enum(BUILD_SIZES).optional(),
});
