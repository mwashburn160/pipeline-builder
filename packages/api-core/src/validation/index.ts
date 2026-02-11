/**
 * @module validation
 * @description Zod validation schemas and utilities
 *
 * Provides runtime validation with TypeScript type inference.
 * All schemas follow the principle of "parse, don't validate" - they
 * transform and validate input, then return strongly-typed output.
 */

export * from './common-schemas';
export * from './pipeline-schemas';
export * from './plugin-schemas';
export * from './middleware';
