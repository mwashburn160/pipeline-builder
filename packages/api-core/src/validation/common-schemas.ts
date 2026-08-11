// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Must run before any z.* schema creation — Zod 4 requires eager extension
import '../openapi/extend-zod.js';
import { z } from 'zod';

/**
 * Access modifier schema
 * Defines visibility of resources (public or private)
 */
export const AccessModifierSchema = z.enum(['public', 'private']);

/**
 * Developer-portal catalog-metadata schemas — shared by pipeline and plugin
 * create/update bodies (and the filter schema below). Mirror the shared types
 * in `types/catalog-metadata.ts`.
 */
export const LifecycleSchema = z.enum(['experimental', 'production', 'deprecated']);
export const CriticalitySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const OwnerTypeSchema = z.enum(['user', 'team']);

export const EntityLinkSchema = z.object({
  title: z.string().min(1).max(120),
  url: z.string().url().max(2048),
  icon: z.string().max(40).optional(),
});

/** Typed classification labels: `{ team: 'payments', tier: 'gold' }`. */
export const EntityLabelsSchema = z.record(z.string().min(1).max(63), z.string().max(255));

/**
 * Catalog-metadata fields common to catalog entities. Spread into create/update
 * body schemas so pipelines and plugins accept identical ownership/lifecycle/
 * classification input. All optional — owner defaults to the creator server-side.
 */
export const CatalogMetadataShape = {
  ownerId: z.string().min(1).max(255).optional(),
  ownerType: OwnerTypeSchema.optional(),
  lifecycle: LifecycleSchema.optional(),
  criticality: CriticalitySchema.optional(),
  labels: EntityLabelsSchema.optional(),
  links: z.array(EntityLinkSchema).max(50).optional(),
} as const;

/**
 * Sort order schema
 */
export const SortOrderSchema = z.enum(['asc', 'desc']);

/**
 * Pagination parameters schema
 */
export const MAX_PAGE_LIMIT = parseInt(process.env.MAX_PAGE_LIMIT || '1000', 10);

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
  // Developer-portal catalog filters (applied only by entities that carry
  // owner/lifecycle columns — pipelines and plugins).
  ownerId: z.string().min(1).optional(),
  lifecycle: LifecycleSchema.optional(),
});
