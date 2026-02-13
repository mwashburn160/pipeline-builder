/**
 * @module validation/plugin-schemas
 * @description Zod schemas for plugin validation
 */

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, AccessModifierSchema } from './common-schemas';

/**
 * Plugin filter schema for query parameters
 */
export const PluginFilterSchema = BaseFilterSchema.extend({
  name: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
  imageTag: z.string().min(1).optional(),
  pluginType: z.string().optional(),
});

/**
 * Plugin creation schema
 */
export const PluginCreateSchema = z.object({
  orgId: z.string().min(1, 'Organization ID is required'),
  name: z.string().min(1, 'Plugin name is required'),
  version: z.string().min(1, 'Version is required'),
  imageTag: z.string().min(1, 'Image tag is required'),
  accessModifier: AccessModifierSchema.optional(),
  pluginType: z.string().optional(),
  computeType: z.string().optional(),
  primaryOutputDirectory: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  installCommands: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
});

/**
 * Plugin update schema
 */
export const PluginUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  version: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  pluginType: z.string().optional(),
  computeType: z.string().optional(),
  primaryOutputDirectory: z.string().nullable().optional(),
  env: z.record(z.string(), z.string()).optional(),
  installCommands: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  accessModifier: AccessModifierSchema.optional(),
});

/**
 * Plugin upload body schema (multipart form-data text fields)
 */
export const PluginUploadBodySchema = z.object({
  accessModifier: AccessModifierSchema.optional(),
});

/**
 * Infer TypeScript types from schemas
 * Note: Prefixed with "Validated" to avoid conflicts with existing type definitions
 */
export type ValidatedPluginFilter = z.infer<typeof PluginFilterSchema>;
export type ValidatedPluginCreate = z.infer<typeof PluginCreateSchema>;
export type ValidatedPluginUpdate = z.infer<typeof PluginUpdateSchema>;
export type ValidatedPluginUploadBody = z.infer<typeof PluginUploadBodySchema>;
