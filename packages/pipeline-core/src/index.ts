// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @mwashburn160/pipeline-core
 *
 * Application configuration, pipeline domain types, and CDK constructs.
 *
 * **Config**
 * - Config — application configuration singleton (environment-driven)
 * - ConfigTypes — typed configuration interfaces
 *
 * **Types**
 * - PipelineType, ComputeType, AccessModifier, PluginType — pipeline domain enums
 * - NetworkTypes, RoleTypes, SecurityGroupTypes — infrastructure type definitions
 * - SourceTypes, StepTypes — pipeline source and step configuration types
 * - IdGenerator — deterministic ID generation
 *
 * **CDK Constructs**
 * - PipelineBuilder — top-level CDK pipeline construct
 * - StageBuilder — pipeline stage composition
 * - PipelineConfiguration — pipeline config resolution
 * - PluginLookup — plugin resolution for pipeline steps
 * - ArtifactManager — build artifact management
 *
 * **Helpers**
 * - replaceNonAlphanumeric, extractMetadataEnv — string and metadata utilities
 * - buildConfigFromMetadata, metadataForCodePipeline, etc. — metadata builders
 *
 * **Re-exports from api-core**
 * - ErrorCode, createLogger
 *
 * **Re-exports from pipeline-data**
 * - db, schema, getConnection, closeConnection — database access
 * - CrudService, BaseEntity — CRUD service infrastructure
 * - All query condition builders and filter types
 * - Compliance domain types (RuleSeverity, RuleTarget, etc.)
 * - drizzleRows, drizzleCount — type helpers
 */

// Configuration
export * from './config/app-config';
export * from './config/config-types';

// Core types (public surface)
export * from './core/pipeline-types';
export * from './core/network-types';
export * from './core/role-types';
export * from './core/security-group-types';
export * from './core/id-generator';
export { replaceNonAlphanumeric, extractMetadataEnv } from './core/pipeline-helpers';
export {
  buildConfigFromMetadata,
  metadataForCodePipeline,
  metadataForCodeBuildStep,
  metadataForShellStep,
  metadataForBuildEnvironment,
} from './core/metadata-builder';
export * from './core/artifact-manager';

// Re-export from api-core (only items consumed by external packages)
export {
  ErrorCode,
  createLogger,
} from '@mwashburn160/api-core';

// Re-export database layer from pipeline-data (only items consumed externally)
export {
  // Database connection
  db,
  getConnection,
  closeConnection,

  // Schema & tables
  schema,

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
} from '@mwashburn160/pipeline-data';

// Pipeline (CDK constructs)
export * from './pipeline/source-types';
export * from './pipeline/step-types';
export * from './pipeline/stage-builder';
export * from './pipeline/pipeline-builder';
export * from './pipeline/plugin-lookup';
export { PipelineConfiguration } from './pipeline/pipeline-configuration';
