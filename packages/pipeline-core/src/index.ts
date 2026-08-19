// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/pipeline-core
 *
 * Application configuration, pipeline domain types, and the template engine.
 *
 * This entry point is deliberately FREE of `aws-cdk-lib`. The CDK constructs live
 * behind a separate subpath — `@pipeline-builder/pipeline-core/cdk` — because the
 * API services consume this package for config and domain types only, and an
 * `export *` of the constructs from here put the whole of `aws-cdk-lib` on the
 * import graph of every service that read so much as a port number. Anything that
 * imports `aws-cdk-lib`, at type level or value level, belongs in `cdk.ts`.
 *
 * **Config**
 * - Config — application configuration singleton (environment-driven)
 * - ConfigTypes — typed configuration interfaces
 *
 * **Types**
 * - PipelineType, ComputeType, AccessModifier, PluginType — pipeline domain enums
 * - RoleTypes, SecurityGroupTypes — infrastructure type definitions
 * - PluginSpec — a plugin's declared contract
 * - IdGenerator — deterministic ID generation
 *
 * **Helpers**
 * - replaceNonAlphanumeric, extractMetadataEnv — string and metadata utilities
 *
 * **Re-exports from api-core**
 * - ErrorCode, createLogger
 *
 * The Postgres/Drizzle data layer (db, schema, CrudService, query builders,
 * filter/compliance types, etc.) is NOT re-exported here — import those
 * directly from `@pipeline-builder/pipeline-data`.
 */

// Configuration
export * from './config/app-config.js';
export * from './config/config-types.js';
export * from './config/entitlements.js';
export * from './config/service-client.js';
export { parsePlatformBaseUrl } from './config/infrastructure-config.js';

// Core types (public surface)
export * from './core/pipeline-types.js';
export * from './core/role-types.js';
export * from './core/security-group-types.js';
export * from './core/id-generator.js';
export { replaceNonAlphanumeric, extractMetadataEnv } from './core/metadata-helpers.js';

// Plugin domain type (the synth-time authoring types live in the `/cdk` entry)
export * from './pipeline/plugin-spec.js';

// Re-export from api-core (only items consumed by external packages)
export {
  ErrorCode,
  createLogger,
} from '@pipeline-builder/api-core';

// Template engine — synth-time scripting for pipeline config + plugin specs
export * from './template/index.js';
