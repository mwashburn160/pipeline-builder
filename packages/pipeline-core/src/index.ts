// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/pipeline-core
 *
 * Application configuration, pipeline domain types, and CDK constructs.
 *
 * **Config**
 * - Config  application configuration singleton (environment-driven)
 * - ConfigTypes  typed configuration interfaces
 *
 * **Types**
 * - PipelineType, ComputeType, AccessModifier, PluginType  pipeline domain enums
 * - NetworkTypes, RoleTypes, SecurityGroupTypes  infrastructure type definitions
 * - SourceTypes, StepTypes  pipeline source and step configuration types
 * - IdGenerator  deterministic ID generation
 *
 * **CDK Constructs**
 * - PipelineBuilder  top-level CDK pipeline construct
 * - StageBuilder  pipeline stage composition
 * - PipelineConfiguration  pipeline config resolution
 * - PluginLookup  plugin resolution for pipeline steps
 * - ArtifactManager  build artifact management
 *
 * **Helpers**
 * - replaceNonAlphanumeric, extractMetadataEnv  string and metadata utilities
 * - buildConfigFromMetadata, metadataForCodePipeline, etc.  metadata builders
 *
 * **Re-exports from api-core**
 * - ErrorCode, createLogger
 *
 * **Re-exports from pipeline-data**
 * - db, schema, getConnection, closeConnection  database access
 * - CrudService, BaseEntity  CRUD service infrastructure
 * - All query condition builders and filter types
 * - Compliance domain types (RuleSeverity, RuleTarget, etc.)
 * - drizzleRows, drizzleCount  type helpers
 */

// Configuration
export * from './config/app-config.js';
export * from './config/config-types.js';
export * from './config/service-client.js';
export { parsePlatformBaseUrl } from './config/infrastructure-config.js';

// Core types (public surface)
export * from './core/pipeline-types.js';
export * from './core/network-types.js';
export * from './core/role-types.js';
export * from './core/security-group-types.js';
export * from './core/id-generator.js';
export { replaceNonAlphanumeric, extractMetadataEnv } from './core/pipeline-helpers.js';
export {
  buildConfigFromMetadata,
  metadataForCodePipeline,
  metadataForCodeBuildStep,
  metadataForShellStep,
  metadataForBuildEnvironment,
} from './core/metadata-builder.js';
export * from './core/artifact-manager.js';

// Re-export from api-core (only items consumed by external packages)
export {
  ErrorCode,
  createLogger,
} from '@pipeline-builder/api-core';

// Re-export database layer from pipeline-data (only items consumed externally)
export {
  // Database connection
  db,
  getConnection,
  closeConnection,

  // Schema & tables
  schema,

  // Tenant-context primitives (Postgres RLS enforcement)
  tenantContext,
  runWithTenantContext,
  getTenantContext,
  withTenantTx,
  type TenantContext,

  // Query builders
  buildPluginConditions,
  buildPipelineConditions,
  buildMessageConditions,
  validateMessageFilter,
  buildCompliancePolicyConditions,
  buildComplianceRuleConditions,
  buildComplianceExemptionConditions,
  buildComplianceAuditConditions,
  buildComplianceScanConditions,
  buildPublishedRuleCatalogConditions,
  buildComplianceRuleSubscriptionConditions,

  // Query filter types
  type PluginFilter,
  type PipelineFilter,
  type MessageFilter,
  type CompliancePolicyFilter,
  type ComplianceRuleFilter,
  type ComplianceExemptionFilter,
  type ComplianceAuditFilter,
  type ComplianceScanFilter,
  type ComplianceRuleSubscriptionFilter,

  // Plugin types
  type PluginSecret,

  // Compliance types
  type RuleSeverity,
  type RuleTarget,
  type RuleOperator,
  type RuleConditionMode,
  type RuleScope,
  type RuleCondition,
  type ComplianceRoleType,

  // CRUD service
  CrudService,
  type BaseEntity,

  // Drizzle type helpers
  drizzleRows,
  drizzleCount,

  // Migration runner (idempotent startup hook)
  runMigrations,
  type MigrateOptions,

  // Reporting service (cache invalidation hook for plugin/reporting events)
  reportingService,
} from '@pipeline-builder/pipeline-data';

// Pipeline (CDK constructs)
export * from './pipeline/source-types.js';
export * from './pipeline/step-types.js';
export * from './pipeline/stage-builder.js';
export * from './pipeline/pipeline-builder.js';
export * from './pipeline/plugin-lookup.js';
export { PipelineConfiguration } from './pipeline/pipeline-configuration.js';

// Template engine  synth-time scripting for pipeline config + plugin specs
export * from './template/index.js';
