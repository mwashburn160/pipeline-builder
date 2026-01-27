import { Duration, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IFileSetProducer } from 'aws-cdk-lib/pipelines';
import { Algorithm } from 'jsonwebtoken';
import type { ComputeType, PluginType, MetaDataType, SourceType, TriggerType } from './types';
import { PluginFilter } from '../db/props-filters';
import { Plugin } from '../db/schema';

/**
 * S3 source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: S3Source = {
 *   type: 's3',
 *   options: {
 *     bucketName: 'my-source-bucket',
 *     objectKey: 'source.zip',
 *     trigger: TriggerType.POLL
 *   }
 * };
 * ```
 */
export interface S3Source {
  readonly type: 's3';
  readonly options: S3Options;
}

/**
 * GitHub source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: GitHubSource = {
 *   type: 'github',
 *   options: {
 *     repo: 'owner/repository',
 *     branch: 'main',
 *     trigger: TriggerType.POLL
 *   }
 * };
 * ```
 */
export interface GitHubSource {
  readonly type: 'github';
  readonly options: GitHubOptions;
}

/**
 * CodeStar connection source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: CodeStarSource = {
 *   type: 'codestar',
 *   options: {
 *     repo: 'owner/repository',
 *     branch: 'main',
 *     connectionArn: 'arn:aws:codestar-connections:...',
 *     trigger: TriggerType.POLL
 *   }
 * };
 * ```
 */
export interface CodeStarSource {
  readonly type: 'codestar';
  readonly options: CodeStarOptions;
}

/**
 * Configuration options for S3 pipeline source
 */
export interface S3Options {
  /**
   * Name of the S3 bucket containing the source code
   * @example 'my-pipeline-source-bucket'
   */
  readonly bucketName: string;

  /**
   * Object key (path) to the source archive within the bucket
   * @default 'source.zip'
   */
  readonly objectKey?: string;

  /**
   * Pipeline trigger behavior
   * @default TriggerType.NONE
   */
  readonly trigger?: TriggerType;
}

/**
 * Configuration options for GitHub pipeline source
 */
export interface GitHubOptions {
  /**
   * GitHub repository in the format "owner/repo"
   * @example 'myorg/myrepo'
   */
  readonly repo: string;

  /**
   * Branch to track
   * @default 'main'
   */
  readonly branch?: string;

  /**
   * GitHub personal access token or SecretValue
   * If not provided, uses default GitHub authentication
   */
  readonly token?: SecretValue | string;

  /**
   * Pipeline trigger behavior
   * @default TriggerType.NONE
   */
  readonly trigger?: TriggerType;
}

/**
 * Configuration options for CodeStar connection pipeline source
 */
export interface CodeStarOptions {
  /**
   * Repository identifier in the format "owner/repo"
   * @example 'myorg/myrepo'
   */
  readonly repo: string;

  /**
   * Branch to track
   * @default 'main'
   */
  readonly branch?: string;

  /**
   * ARN of the CodeStar connection to use
   * Can be a string ARN or SecretValue
   * @example 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abc123'
   */
  readonly connectionArn: SecretValue | string;

  /**
   * Pipeline trigger behavior
   * @default TriggerType.NONE
   */
  readonly trigger?: TriggerType;

  /**
   * Whether to enable full clone capability in CodeBuild
   * When true, CodeBuild can perform git operations on the full repository
   * @default false
   */
  readonly codeBuildCloneOutput?: boolean;
}

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

  /**
   * Additional metadata that can be accessed during plugin execution
   * Keys should use the format 'custom:aws:prefix:key'
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
   * @example { NODE_ENV: 'production', API_URL: 'https://api.example.com' }
   */
  readonly env?: Record<string, string>;
}

/**
 * Options for creating a CodeBuild step in the pipeline
 */
export interface CodeBuildStepOptions {
  /**
   * Unique identifier for this CodeBuild step
   * Should be descriptive and unique within the pipeline
   * @example 'my-org-my-project-synth'
   */
  readonly id: string;

  /**
   * Plugin configuration from the database
   * Contains all the plugin's manifest data and runtime information
   */
  readonly plugin: Plugin;

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
}

/**
 * Type-safe configuration interface
 */
export interface AppConfig {
  server: ServerConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  registry: RegistryConfig;
  aws: AWSConfig;
  rateLimit: RateLimitConfig;
}

export interface ServerConfig {
  port: string;
  cors: {
    credentials: boolean;
    origin: string | string[];
  };
  platformUrl: string;
}

export interface AuthConfig {
  jwt: {
    secret: string;
    expiresIn: string;
    algorithm: Algorithm;
    saltRounds: string;
  };
  refreshToken: {
    secret: string;
    expiresIn: string;
  };
}

export interface DatabaseConfig {
  postgres: {
    host: string;
    port: string;
    database: string;
    user: string;
    password: string;
  };
  mongodb: {
    uri: string;
  };
  drizzle: {
    maxPoolSize: string;
    idleTimeoutMillis: string;
    connectionTimeoutMillis: string;
  };
}

export interface RegistryConfig {
  host: string;
  port: string;
  user: string;
  token: string;
}

export interface AWSConfig {
  lambda: {
    runtime: Runtime;
    timeout: Duration;
    memorySize: number;
    architecture: Architecture;
  };
  logging: {
    groupName: string;
    retention: RetentionDays;
    removalPolicy: RemovalPolicy;
  };
  codeBuild: {
    computeType: ComputeType;
  };
}

export interface RateLimitConfig {
  max: string;
  windowMs: string;
  legacyHeaders: boolean;
  standardHeaders: boolean;
}