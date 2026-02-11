/**
 * @module validation/pipeline-schemas
 * @description Zod schemas for pipeline validation
 */

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, AccessModifierSchema } from './common-schemas';

/**
 * Pipeline filter schema for query parameters
 */
export const PipelineFilterSchema = BaseFilterSchema.extend({
  project: z.string().min(1).optional(),
  organization: z.string().min(1).optional(),
  pipelineName: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
});

/**
 * Pipeline creation schema
 */
export const PipelineCreateSchema = z.object({
  project: z.string().min(1, 'Project is required'),
  organization: z.string().min(1, 'Organization is required'),
  pipelineName: z.string().min(1).optional(),
  accessModifier: AccessModifierSchema.optional(),
  props: z.record(z.string(), z.unknown()),
});

/**
 * Pipeline update schema
 */
export const PipelineUpdateSchema = z.object({
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  accessModifier: AccessModifierSchema.optional(),
});

/**
 * Infer TypeScript types from schemas
 * Note: Prefixed with "Validated" to avoid conflicts with existing type definitions
 */
export type ValidatedPipelineFilter = z.infer<typeof PipelineFilterSchema>;
export type ValidatedPipelineCreate = z.infer<typeof PipelineCreateSchema>;
export type ValidatedPipelineUpdate = z.infer<typeof PipelineUpdateSchema>;
