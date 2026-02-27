/**
 * @module openapi/schema-registry
 * @description Registers all Zod validation schemas with OpenAPI metadata.
 *
 * This module extends Zod with the .openapi() method and registers every
 * shared schema so they appear as named components in the OpenAPI spec.
 * Registrations are deferred — they execute lazily when the spec is first
 * generated, not at import time.
 */

import { z } from 'zod';

import { registry, addRegistration } from './registry';
import {
  AIGenerateBodySchema,
  PluginDeployGeneratedSchema,
} from '../validation/ai-schemas';
import {
  AccessModifierSchema,
  PaginationSchema,
  BaseFilterSchema,
} from '../validation/common-schemas';
import {
  MessageFilterSchema,
  MessageCreateSchema,
  MessageReplySchema,
} from '../validation/message-schemas';
import {
  PipelineFilterSchema,
  PipelineCreateSchema,
  PipelineUpdateSchema,
} from '../validation/pipeline-schemas';
import {
  PluginFilterSchema,
  PluginCreateSchema,
  PluginUpdateSchema,
  PluginUploadBodySchema,
} from '../validation/plugin-schemas';

// Response schemas (exported for type usage)
export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  statusCode: z.number(),
  data: z.unknown().optional(),
  message: z.string().optional(),
});

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  statusCode: z.number(),
  message: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

export const PaginatedResponseSchema = z.object({
  success: z.literal(true),
  statusCode: z.number(),
  data: z.array(z.unknown()),
  count: z.number(),
  limit: z.number(),
  offset: z.number(),
  total: z.number().optional(),
  message: z.string().optional(),
});

addRegistration(() => {
  // Common schemas
  registry.register('AccessModifier', AccessModifierSchema.openapi({
    description: 'Resource visibility: "public" (visible to all) or "private" (organization only)',
    example: 'private',
  }));

  registry.register('PaginationParams', PaginationSchema.openapi({
    description: 'Standard pagination and sorting parameters',
  }));

  registry.register('BaseFilter', BaseFilterSchema.openapi({
    description: 'Common filter fields shared by all entity queries',
  }));

  // Pipeline schemas
  registry.register('PipelineFilter', PipelineFilterSchema.openapi({
    description: 'Query filters for listing pipelines',
  }));

  registry.register('PipelineCreate', PipelineCreateSchema.openapi({
    description: 'Request body for creating a new pipeline',
  }));

  registry.register('PipelineUpdate', PipelineUpdateSchema.openapi({
    description: 'Request body for updating an existing pipeline',
  }));

  // Plugin schemas
  registry.register('PluginFilter', PluginFilterSchema.openapi({
    description: 'Query filters for listing plugins',
  }));

  registry.register('PluginCreate', PluginCreateSchema.openapi({
    description: 'Request body for creating a new plugin',
  }));

  registry.register('PluginUpdate', PluginUpdateSchema.openapi({
    description: 'Request body for updating an existing plugin',
  }));

  registry.register('PluginUploadBody', PluginUploadBodySchema.openapi({
    description: 'Metadata for plugin ZIP upload (multipart form-data)',
  }));

  // Message schemas
  registry.register('MessageFilter', MessageFilterSchema.openapi({
    description: 'Query filters for listing messages',
  }));

  registry.register('MessageCreate', MessageCreateSchema.openapi({
    description: 'Request body for creating a new message or announcement',
  }));

  registry.register('MessageReply', MessageReplySchema.openapi({
    description: 'Request body for replying to a message thread',
  }));

  // AI schemas
  registry.register('AIGenerateBody', AIGenerateBodySchema.openapi({
    description: 'Request body for AI-powered generation (pipeline or plugin)',
  }));

  registry.register('PluginDeployGenerated', PluginDeployGeneratedSchema.openapi({
    description: 'Request body for deploying an AI-generated plugin',
  }));

  // Response schemas
  registry.register('SuccessResponse', SuccessResponseSchema.openapi('SuccessResponse'));
  registry.register('ErrorResponse', ErrorResponseSchema.openapi('ErrorResponse'));
  registry.register('PaginatedResponse', PaginatedResponseSchema.openapi('PaginatedResponse'));
});
