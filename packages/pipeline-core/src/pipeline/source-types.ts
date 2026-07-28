// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SecretValue } from 'aws-cdk-lib';
import type { TriggerType } from '../core/pipeline-types.js';

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
 *     trigger: TriggerType.AUTO
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
 *     trigger: TriggerType.AUTO
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
 *     trigger: TriggerType.AUTO
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

  /**
   * Cron expression for scheduled trigger (e.g., 'cron(0 0 * * ? *)' for daily).
   * Only used when trigger is SCHEDULE.
   */
  readonly schedule?: string;
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
   * GitHub authentication token.
   *
   * Prefer a Secrets Manager reference so the token value never lands in the
   * synthesized CloudFormation template / CDK context. Accepted forms:
   *   - a `SecretValue` (e.g. `SecretValue.secretsManager(...)`),
   *   - a Secrets Manager ARN string (`arn:aws:secretsmanager:...`),
   *   - a `secretsmanager:<secret-name>` shorthand string.
   *
   * A genuine raw plaintext token (e.g. a `ghp_...` PAT) is rejected by default,
   * because baking it in would expose it to anyone with template/state access —
   * set {@link allowPlainTextToken} to intentionally embed it.
   *
   * If not provided, uses default GitHub authentication. Consider a CodeStar
   * connection (`type: 'codestar'`) as the modern, credential-free path.
   */
  readonly token?: SecretValue | string;

  /**
   * Opt-in escape hatch to embed a raw plaintext {@link token} directly in the
   * synthesized template. Insecure — the token becomes readable by anyone with
   * template, CDK context, or stack state access. Leave unset (default) to force
   * a Secrets Manager reference instead.
   * @default false
   */
  readonly allowPlainTextToken?: boolean;

  /**
   * Pipeline trigger behavior
   * @default TriggerType.NONE
   */
  readonly trigger?: TriggerType;

  /**
   * Cron expression for scheduled trigger (e.g., 'cron(0 0 * * ? *)' for daily).
   * Only used when trigger is SCHEDULE.
   */
  readonly schedule?: string;
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
   * Cron expression for scheduled trigger (e.g., 'cron(0 0 * * ? *)' for daily).
   * Only used when trigger is SCHEDULE.
   */
  readonly schedule?: string;

  /**
   * Whether to enable full clone capability in CodeBuild
   * When true, CodeBuild can perform git operations on the full repository
   * @default false
   */
  readonly codeBuildCloneOutput?: boolean;
}

/**
 * CodeCommit source configuration for CodePipeline
 *
 * @example
 * ```typescript
 * const source: CodeCommitSourceConfig = {
 *   type: 'codecommit',
 *   options: {
 *     repositoryName: 'my-repo',
 *     branch: 'main',
 *     trigger: TriggerType.AUTO
 *   }
 * };
 * ```
 */
export interface CodeCommitSourceConfig {
  readonly type: 'codecommit';
  readonly options: CodeCommitOptions;
}

/**
 * Configuration options for CodeCommit pipeline source
 */
export interface CodeCommitOptions {
  /**
   * Name of the CodeCommit repository
   * @example 'my-repo'
   */
  readonly repositoryName: string;

  /**
   * Branch to track
   * @default 'main'
   */
  readonly branch?: string;

  /**
   * Pipeline trigger behavior
   * @default TriggerType.NONE
   */
  readonly trigger?: TriggerType;
}
