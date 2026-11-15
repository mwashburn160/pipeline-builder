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
export { ComputeType, PluginType, type MetaDataType, type Visibility, MetadataKeys, type MetadataKey } from './core/pipeline-types.js';
export * from './core/role-types.js';
export * from './core/security-group-types.js';
export { replaceNonAlphanumeric, extractMetadataEnv, resolveFailureBehavior, wrapCommandsForFailureBehavior, STEP_BOOTSTRAP_CMD } from './core/metadata-helpers.js';
export {
  BUILD_IMAGE_MANIFEST_ACTION,
  BUILD_IMAGE_MANIFEST_STAGE,
  BUILD_IMAGE_STEP_KEY,
  STEP_MANIFEST_FILE,
  type StepManifestEntry,
  type BuildImageManifestEntry,
  type PluginImageRef,
  pluginImageRepository,
} from './core/step-manifest.js';
export {
  type ContractValueType,
  type PluginContract,
  type ContractScope,
  type ContractIssue,
  type ContractScopeProps,
  pipelineScopeMetadata,
  pipelineContractScope,
  checkPluginContract,
  type PluginStepRef,
  collectPluginSteps,
  pluginLookupFilter,
  pluginArtifactAlias,
  pluginStepLabel,
  type PluginRefIdentity,
} from './core/plugin-contract.js';
export {
  unwrapLookup,
  summarizeLookupWarnings,
  type LookupWarning,
  type LookupWarningSeverity,
  lookupNotFoundState,
  exactPinNotFoundMessage,
  type LookupNotFoundState,
  parseLookupToolchain,
  type ToolchainVersions,
  type LookupToolchain,
  type ResolvedBootstrap,
  RESOLVED_PLUGIN_OMITTED_FIELDS,
  type ResolvedPlugin,
  toResolvedPlugin,
} from './core/plugin-lookup-envelope.js';
export * from './core/synth-failure.js';
export {
  RUNTIME_CHECK_STEPS_ENV,
  type RuntimeCheckStep,
  type RuntimeCheckVerdict,
  RUNTIME_CHECK_VERDICTS,
  type RuntimeCheckResult,
  parseRuntimeCheckSteps,
} from './core/runtime-check.js';
export { platformCaList, platformTlsVerify } from './core/platform-tls.js';
export { sanitizeCorrelationValue, correlationHeaders } from './core/audit-correlation.js';
export * from './core/quota-exceeded.js';
export { SECURITY_REPORT_FORMATS, type SecurityReportFormat } from './core/security-reports.js';
export * from './core/pipeline-registration.js';

// Plugin domain type (the synth-time authoring types live in the `/cdk` entry)
// CDK-free: the DORA deploy attribution the API reports in create/validate
// responses. The construct that stamps the tag reads the same function.
export {
  type DeployPair,
  type DeployAttributionStage,
  type DeployAttributionInput,
  type DeployAttribution,
  type DeployAttributionWarning,
  type DeployAttributionReport,
  describeDeployAttribution,
} from './pipeline/deploy-attribution.js';
// CDK-free: the stage/plugin/IAM projection the create + validate responses return
// so a reviewer approves something concrete rather than raw props JSON.
export * from './pipeline/structure-preview.js';
export * from './pipeline/plugin-spec.js';

// Template engine — synth-time scripting for pipeline config + plugin specs
export {
  tokenize,
  hasTemplate,
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
  type TemplateDraftInput,
  type TemplateDraftLike,
  type TemplateDraftProblem,
  type TemplateDraftProblemKind,
  type TemplateDraftValidation,
} from './template/index.js';
// A plugin's `{{ … }}` resolution against a pipeline scope (synth, `plugin test`)
export { resolvePluginTemplates } from './template/plugin-resolver.js';
