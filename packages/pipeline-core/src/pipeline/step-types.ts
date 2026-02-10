import type { PluginFilter, Plugin } from '@mwashburn160/pipeline-data';
import type { ComputeType as CdkComputeType } from 'aws-cdk-lib/aws-codebuild';
import { IFileSetProducer } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { UniqueId } from '../core/id-generator';
import type { NetworkConfig } from '../core/network-types';
import type { ComputeType, PluginType, MetaDataType, SourceType } from '../core/pipeline-types';

/**
 * Options for selecting and configuring a plugin
 */
export interface PluginOptions {
  /**
   * Name of the plugin to use
   * Must match a registered plugin in the database
   */
  readonly name: string;

  /**
   * Optional alias for the plugin instance
   * Useful when using the same plugin multiple times with different configurations
   */
  readonly alias?: string;

  /**
   * Optional filter criteria for plugin selection
   * Can be used to select specific plugin versions or variants
   */
  readonly filter?: PluginFilter;

  /**
   * Additional metadata to merge with plugin's default metadata
   * This metadata will be available to the plugin during execution
   */
  readonly metadata?: MetaDataType;
}

/**
 * Synthesis step configuration combining source and plugin
 */
export interface SynthOptions {
  /**
   * Source configuration (S3, GitHub, or CodeStar)
   */
  readonly source: SourceType;

  /**
   * Plugin to use for synthesis
   */
  readonly plugin: PluginOptions;

  /**
   * Additional metadata for the synthesis step
   * This will be merged with global metadata and plugin metadata
   */
  readonly metadata?: MetaDataType;

  /**
   * Step-level network configuration applied only to the synth CodeBuild step.
   * Overrides the pipeline-level `defaults.network` when both are provided.
   */
  readonly network?: NetworkConfig;
}

/**
 * Plugin manifest defining plugin behavior and requirements
 * This is typically loaded from a plugin definition file
 */
export interface PluginManifest {
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
  readonly dockerfile: string;

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
  readonly commands: string[];

  /**
   * Environment variables to set in the build environment
   * @example { API_URL: 'https://api.example.com', LOG_LEVEL: 'info' }
   */
  readonly env?: Record<string, string>;
}

/**
 * Per-step customization options for commands and environment variables.
 * Custom commands are injected before/after the plugin's commands.
 * Custom env vars are merged on top of the plugin's defaults.
 */
export interface StepCustomization {
  /** Commands to run before the plugin's install commands */
  readonly preInstallCommands?: string[];

  /** Commands to run after the plugin's install commands */
  readonly postInstallCommands?: string[];

  /** Commands to run before the plugin's build commands */
  readonly preCommands?: string[];

  /** Commands to run after the plugin's build commands */
  readonly postCommands?: string[];

  /** Custom environment variables merged on top of the plugin's env */
  readonly env?: Record<string, string>;
}

/**
 * Configuration for a single step within a pipeline stage.
 * Uses PluginOptions for name-based plugin selection (resolved at build time).
 */
export interface StageStepOptions extends StepCustomization {
  /** Plugin to use for this step */
  readonly plugin: PluginOptions;

  /** Step-level metadata merged with stage and global metadata */
  readonly metadata?: MetaDataType;

  /** Optional network configuration for this step's CodeBuild action */
  readonly network?: NetworkConfig;
}

/**
 * A pipeline stage containing one or more build steps.
 * Each stage maps to a CDK Pipeline wave, with steps executing within the wave.
 */
export interface StageOptions {
  /** Display name for this stage */
  readonly stageName: string;

  /** Optional alias used for wave/construct ID generation. Defaults to stageName. */
  readonly alias?: string;

  /** Build steps to execute within this stage */
  readonly steps: StageStepOptions[];
}

/**
 * Options for creating a CodeBuild step in the pipeline
 */
export interface CodeBuildStepOptions extends StepCustomization {
  /**
   * Unique identifier for this CodeBuild step
   * Should be descriptive and unique within the pipeline
   * @example 'my-org-my-project-synth'
   */
  readonly id: string;

  /**
   * UniqueId instance for generating unique construct IDs
   * Used for network resource lookups (VPC, subnets, security groups)
   */
  readonly uniqueId: UniqueId;

  /**
   * Plugin configuration from the database
   * Contains all the plugin's manifest data and runtime information
   */
  readonly plugin: Plugin;

  /**
   * CDK scope used to create constructs (VPC/subnet/security-group lookups).
   */
  readonly scope: Construct;

  /**
   * Input source for this step
   * Typically the output from a previous step or the pipeline source
   */
  readonly input?: IFileSetProducer;

  /**
   * Additional metadata to merge with plugin metadata
   * Will override conflicting keys from plugin metadata
   */
  readonly metadata?: MetaDataType;

  /**
   * Optional network configuration for the CodeBuild step.
   * When provided, resolves VPC, subnet selection, and security groups
   * so the build runs inside the specified network.
   */
  readonly network?: NetworkConfig;

  /**
   * Fallback CodeBuild compute type when the plugin doesn't specify one.
   * @default ComputeType.SMALL
   */
  readonly defaultComputeType?: CdkComputeType;
}
