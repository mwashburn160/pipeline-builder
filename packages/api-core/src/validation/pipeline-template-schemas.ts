// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { AccessModifierSchema, BaseFilterSchema, BooleanQuerySchema, CatalogMetadataShape } from './common-schemas.js';

/**
 * One declared template input — mirrors the `TemplateInput` type. The `name` is
 * the `vars.<name>` key the template body references.
 */
export const TemplateInputSchema = z.object({
  // Identifier only — becomes a `vars.<name>` key. Excludes prototype-pollution
  // keys and anything that isn't a plain identifier.
  name: z.string().min(1).max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'input name must be a valid identifier')
    .refine((n) => !['__proto__', 'constructor', 'prototype'].includes(n), 'reserved input name'),
  label: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string().max(255)).max(50).optional(),
});

/** Pipeline-template list filter (query params). */
export const PipelineTemplateFilterSchema = BaseFilterSchema.extend({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
});

/** Create a pipeline template (author a golden path). */
export const PipelineTemplateCreateSchema = z.object({
  ...CatalogMetadataShape,
  // Bounded to the DB column widths so an over-length value is a clean 400,
  // not a Postgres length error surfaced as a 500.
  name: z.string().min(1, 'Template name is required').max(255),
  description: z.string().max(2000).optional(),
  keywords: z.array(z.string().max(64)).max(50).optional(),
  category: z.string().min(1).max(50).optional(),
  accessModifier: AccessModifierSchema.optional(),
  // Template body: a BuilderProps with `{{ vars.* }}` placeholders.
  props: z.record(z.string(), z.unknown()),
  inputs: z.array(TemplateInputSchema).max(100).optional(),
});

/** Update a pipeline template. */
export const PipelineTemplateUpdateSchema = z.object({
  ...CatalogMetadataShape,
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  keywords: z.array(z.string().max(64)).max(50).optional(),
  category: z.string().min(1).max(50).optional(),
  accessModifier: AccessModifierSchema.optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  inputs: z.array(TemplateInputSchema).max(100).optional(),
  isActive: BooleanQuerySchema.optional(),
});

/**
 * Instantiate a template into a concrete pipeline config. `inputs` supplies the
 * declared `vars.*` values; project/organization/pipelineName name the pipeline.
 */
export const InstantiateTemplateSchema = z.object({
  project: z.string().min(1, 'Project is required'),
  organization: z.string().min(1, 'Organization is required'),
  pipelineName: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
