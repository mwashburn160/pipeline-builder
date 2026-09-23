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
 * - PipelineType, ComputeType, PluginType, Visibility — pipeline domain enums
 * - RoleTypes, SecurityGroupTypes — infrastructure type definitions
 * - PluginSpec — a plugin's declared contract
 * - IdGenerator — deterministic ID generation
 *
 * **Helpers**
 * - replaceNonAlphanumeric, extractMetadataEnv — string and metadata utilities
 * - resolveFailureBehavior, wrapCommandsForFailureBehavior — a step's failureBehavior, as CodeBuild runs it
 *
 * The Postgres/Drizzle data layer (db, schema, CrudService, query builders,
 * filter/compliance types, etc.) is NOT re-exported here — import those
 * directly from `@pipeline-builder/pipeline-data`.
 */

// Configuration
export * from './config/app-config.js';
export * from './config/config-types.js';
export * from './config/service-client.js';
export { parsePlatformBaseUrl } from './config/infrastructure-config.js';

// Core types (public surface)
export { ComputeType, PluginType, type MetaDataType, type Visibility, TriggerType, MetadataKeys, type MetadataKey } from './core/pipeline-types.js';
export * from './core/role-types.js';
export * from './core/security-group-types.js';
export { replaceNonAlphanumeric, extractMetadataEnv, resolveFailureBehavior, wrapCommandsForFailureBehavior, STEP_BOOTSTRAP_CMD } from './core/metadata-helpers.js';
export * from './core/step-manifest.js';
export {
  type ContractValueType,
  type PluginContract,
  type ContractScope,
  type ContractIssue,
  type ContractScopeProps,
  pipelineScopeMetadata,
  pipelineContractScope,
  contractScopeFromTemplateScope,
  isContractValueOfType,
  checkPluginContract,
  type PluginStepRef,
  collectPluginSteps,
  pluginLookupFilter,
  pluginArtifactAlias,
  type PluginRefIdentity,
  sanitizePublisher,
} from './core/plugin-contract.js';
export { unwrapLookup } from './core/plugin-lookup-envelope.js';

// Plugin domain type (the synth-time authoring types live in the `/cdk` entry)
export * from './pipeline/plugin-spec.js';

// Template engine — synth-time scripting for pipeline config + plugin specs
export {
  tokenize,
  hasTemplate,
  MAX_FIELD_SIZE_BYTES,
  MAX_PATH_DEPTH,
  type Token,
  type LiteralToken,
  type ExprToken,
  type SourcePosition,
  resolve,
  dependencies,
  type Scope,
  type FieldPredicate,
  validateTemplates,
  detectCycles,
  allowedScopeRoots,
  type TemplateError,
  type TemplateValidationResult,
  type ResolveResult,
  resolveSelfReferencing,
  validateTemplateDraft,
  formatTemplateDraftProblems,
  type TemplateDraftInput,
  type TemplateDraftLike,
  type TemplateDraftProblem,
  type TemplateDraftProblemKind,
  type TemplateDraftValidation,
} from './template/index.js';
// A plugin's `{{ … }}` resolution against a pipeline scope (synth, `plugin test`)
export { resolvePluginTemplates } from './template/plugin-resolver.js';
