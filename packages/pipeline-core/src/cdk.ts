// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/pipeline-core/cdk
 *
 * The AWS CDK surface: the constructs that assemble a pipeline into a
 * CodePipeline stack, the synth-time authoring types they take, and the adapters
 * that turn plain `AWSConfig` data into CDK value objects.
 *
 * Everything reachable from here pulls in `aws-cdk-lib`, which is why it is a
 * separate entry point from the package root. Import from here only in code that
 * actually synthesizes stacks — the CLI's CDK app. Services that just need config
 * or domain types import `@pipeline-builder/pipeline-core` instead and never load
 * the CDK. `aws-cdk-lib` and `constructs` are peer dependencies; the consuming app
 * supplies them, so there is exactly one copy of each on the resolution graph.
 *
 * **Constructs**
 * - PipelineBuilder — top-level CDK pipeline construct
 * - StageBuilder — pipeline stage composition
 * - PluginLookup — plugin resolution custom resource
 * - ArtifactManager — build artifact management
 * - PipelineConfiguration — pipeline config resolution
 *
 * **Authoring types**
 * - SourceTypes, StepTypes — pipeline source and step configuration
 * - NetworkTypes — VPC/subnet/security-group configuration
 *
 * **Config adapters**
 * - lambdaRuntime, lambdaTimeout, logRetention, ... — `AWSConfig` → CDK values
 */

// Config adapters (plain AWSConfig data → CDK value objects)
export * from './config/aws-config-cdk.js';

// Infrastructure types that reference CDK values
export * from './core/network-types.js';
export * from './core/artifact-manager.js';
export {
  buildConfigFromMetadata,
  metadataForCodePipeline,
  metadataForCodeBuildStep,
  metadataForShellStep,
  metadataForBuildEnvironment,
} from './core/metadata-builder.js';

// Pipeline authoring types and CDK constructs
export * from './pipeline/source-types.js';
export * from './pipeline/step-types.js';
export * from './pipeline/stage-builder.js';
export * from './pipeline/pipeline-builder.js';
export * from './pipeline/plugin-lookup.js';
export { PipelineConfiguration } from './pipeline/pipeline-configuration.js';
