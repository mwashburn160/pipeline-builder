// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `PluginSpec` domain type — the shape of a plugin's declared contract as
 * stored in the database and exchanged over the API.
 *
 * Kept in its own module, apart from the synth-time authoring types in
 * `step-types.ts`, because those reference CDK types (`Construct`,
 * `IFileSetProducer`, CodeBuild's `ComputeType`) while this one is pure data.
 * API services consume `PluginSpec`; only the CDK entry point consumes the rest.
 */

import type { ComputeType, PluginType } from '../core/pipeline-types.js';

/**
 * Plugin spec defining plugin behavior and requirements.
 * This is typically loaded from a plugin spec file (plugin-spec.yaml).
 */
export interface PluginSpec {
  /**
   * Unique identifier for the plugin
   * @example 'nodejs-build'
   */
  readonly name: string;

  /**
   * Human-readable description of what the plugin does
   * @example 'Builds and tests Node.js applications'
   */
  readonly description?: string;

  /**
   * Keywords for plugin discovery and categorization
   * @example ['nodejs', 'typescript', 'build', 'test']
   */
  readonly keywords?: string[];

  /**
   * Plugin category for AI-assisted selection and organization.
   * One of: language, security, quality, testing, deploy, artifact,
   *         infrastructure, monitoring, notification, ai
   */
  readonly category?: string;

  /**
   * Semantic version of the plugin
   * @example '1.0.0'
   */
  readonly version?: string;

  /**
   * Type of pipeline step this plugin creates
   * @default PluginType.CODE_BUILD_STEP
   */
  readonly pluginType?: PluginType;

  /**
   * CodeBuild compute resource size to use
   * @default ComputeType.SMALL
   */
  readonly computeType?: ComputeType;

  /**
   * Maximum execution time in minutes.
   * Used as fallback when the pipeline step doesn't set timeout.
   * @default 60 (AWS CodeBuild default)
   */
  readonly timeout?: number;

  /**
   * What happens when this step fails.
   * - 'fail': Stop the pipeline (default)
   * - 'warn': Log a warning and continue
   * - 'ignore': Silently continue
   * @default 'fail'
   */
  readonly failureBehavior?: 'fail' | 'warn' | 'ignore';

  /**
   * Secret requirements for this plugin.
   * Declares named secrets the plugin expects at build time.
   */
  readonly secrets?: Array<{ name: string; required: boolean; description?: string }>;

  /**
   * Directory containing the primary build output artifacts
   * @example 'dist'
   */
  readonly primaryOutputDirectory?: string;
  /**
   * Additional metadata that can be accessed during plugin execution
   * Keys should use the format 'aws:cdk:{namespace}:{key}' (all lowercase)
   */
  readonly metadata?: Record<string, string | number | boolean>;

  /**
   * Path to Dockerfile or Dockerfile content
   * Used to build the container environment for this plugin
   */
  readonly dockerfile?: string;

  /**
   * Commands to run during the install phase
   * Typically used for installing dependencies
   * @example ['npm ci', 'npm run build']
   */
  readonly installCommands?: string[];

  /**
   * Commands to run during the build/execution phase
   * These are the main commands that perform the plugin's work
   * @example ['npm test', 'npm run deploy']
   */
  readonly commands?: string[];

  /**
   * Environment variables to set in the build environment
   * @example { API_URL: 'https://api.example.com', LOG_LEVEL: 'info' }
   */
  readonly env?: Record<string, string>;

  /**
   * Docker build arguments passed via --build-arg at image build time.
   * Used to parameterize Dockerfile ARG values when building the plugin image.
   * @example { PYTHON_VERSION: '3.12', NODE_ENV: 'production' }
   */
  readonly buildArgs?: Record<string, string>;

  /**
   * Pipeline metadata keys the plugin references via `{{ pipeline.metadata.X }}`.
   * Declared as a contract — pipelines using this plugin must supply all
   * listed keys unless the template uses `| default: '...'`.
   * @example ['env', 'namespace', 'clusterName']
   */
  readonly requiredMetadata?: string[];

  /**
   * Pipeline vars keys the plugin references via `{{ pipeline.vars.X }}`.
   * @example ['branch', 'slackChannel']
   */
  readonly requiredVars?: string[];

  /**
   * Optional type declarations for the metadata keys listed in `requiredMetadata`.
   * Used at upload time to verify that coercion filters (`| number`, `| bool`,
   * `| json`) match the declared type — e.g. `{{ pipeline.metadata.count | number }}`
   * requires `count: 'number'` here, otherwise the plugin is rejected.
   * Keys not declared default to `'string'`.
   * @example { count: 'number', enabled: 'bool' }
   */
  readonly metadataTypes?: Record<string, 'string' | 'number' | 'bool' | 'json'>;

  /**
   * Optional type declarations for vars keys (same semantics as `metadataTypes`).
   */
  readonly varsTypes?: Record<string, 'string' | 'number' | 'bool' | 'json'>;
}
