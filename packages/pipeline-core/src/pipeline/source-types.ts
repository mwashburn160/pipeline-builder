import type { SecretValue } from 'aws-cdk-lib';
import type { TriggerType } from '../core/pipeline-types';

/**
 * S3 source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: S3SourceConfig = {
 *   type: 's3',
 *   options: {
 *     bucketName: 'my-source-bucket',
 *     objectKey: 'source.zip',
 *     trigger: TriggerType.POLL
 *   }
 * };
 * ```
 */
export interface S3SourceConfig {
  readonly type: 's3';
  readonly options: S3Options;
}

/**
 * GitHub source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: GitHubSourceConfig = {
 *   type: 'github',
 *   options: {
 *     repo: 'owner/repository',
 *     branch: 'main',
 *     trigger: TriggerType.POLL
 *   }
 * };
 * ```
 */
export interface GitHubSourceConfig {
  readonly type: 'github';
  readonly options: GitHubOptions;
}

/**
 * CodeStar connection source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: CodeStarSourceConfig = {
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
export interface CodeStarSourceConfig {
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
