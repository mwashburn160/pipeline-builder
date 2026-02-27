/**
 * @module validation/common-schemas
 * @description Common Zod schemas shared across all APIs
 */

// Must run before any z.* schema creation — Zod 4 requires eager extension
import '../openapi/extend-zod';
import { z } from 'zod';

/**
 * Access modifier schema
 * Defines visibility of resources (public or private)
 */
export const AccessModifierSchema = z.enum(['public', 'private']);

/**
 * Sort order schema
 */
export const SortOrderSchema = z.enum(['asc', 'desc']);

/**
 * Pagination parameters schema
 */
const MAX_PAGE_LIMIT = parseInt(process.env.MAX_PAGE_LIMIT || '1000');

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sortBy: z.string().optional(),
  sortOrder: SortOrderSchema.optional(),
});

/**
 * Boolean query parameter schema
 * Handles string "true"/"false" and boolean values
 */
export const BooleanQuerySchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform(val => val === 'true'),
  z.string().transform(val => val === 'true'),
]);

/**
 * UUID schema with validation
 */
export const UUIDSchema = z.string().uuid({
  message: 'Invalid UUID format',
});

/**
 * Optional UUID schema (for partial UUIDs or prefixes)
 */
export const UUIDPrefixSchema = z.string().regex(/^[0-9a-f-]+$/i, {
  message: 'Invalid UUID prefix format',
});

/**
 * Base filter schema for entities with common fields
 */
export const BaseFilterSchema = z.object({
  id: z.union([UUIDSchema, z.array(UUIDSchema), UUIDPrefixSchema]).optional(),
  accessModifier: AccessModifierSchema.optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
});

/**
 * Infer TypeScript types from schemas
 * Note: Prefixed with "Validated" to avoid conflicts with existing type definitions
 */
export type ValidatedAccessModifier = z.infer<typeof AccessModifierSchema>;
export type ValidatedSortOrder = z.infer<typeof SortOrderSchema>;
export type ValidatedPaginationParams = z.infer<typeof PaginationSchema>;
export type ValidatedBaseFilter = z.infer<typeof BaseFilterSchema>;
