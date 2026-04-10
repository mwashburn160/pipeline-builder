// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SecretValue } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-codecommit';
import { CodeCommitTrigger, GitHubTrigger, S3Trigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import type { PipelineConfiguration } from './pipeline-configuration';
import { UniqueId } from '../core/id-generator';
import { unwrapSecret } from '../core/pipeline-helpers';
import { TriggerType, type SourceType } from '../core/pipeline-types';

/**
 * Creates the appropriate CodePipelineSource based on the pipeline configuration.
 *
 * Supports S3, GitHub, CodeStar connection, and CodeCommit sources.
 *
 * **Note on SCHEDULE triggers:** Scheduled pipelines require an EventBridge rule
 * that starts the pipeline on a cron schedule. The source trigger is set to NONE
 * (no polling/webhook). The EventBridge rule must be created separately as a
 * pipeline-level construct, not at the source level. The `schedule` field on
 * source options captures the cron expression for API/frontend use, but the
 * actual EventBridge rule creation is not yet implemented in this builder.
 *
 * @example
 * ```typescript
 * const sourceBuilder = new SourceBuilder(this, config);
 * const source = sourceBuilder.create(uniqueId);
 * ```
 */
export class SourceBuilder {
  constructor(
    private readonly scope: Construct,
    private readonly config: PipelineConfiguration,
  ) {}

  /**
   * Creates the appropriate CodePipelineSource based on source type
   */
  create(id: UniqueId): CodePipelineSource {
    switch (this.config.source.type) {
      case 's3':
        return this.createS3Source(id);
      case 'github':
        return this.createGitHubSource();
      case 'codestar':
        return this.createCodeStarSource();
      case 'codecommit':
        return this.createCodeCommitSource(id);
      default: {
        const _exhaustive: never = this.config.source;
        throw new Error(`Unsupported source type: ${(_exhaustive as SourceType).type}`);
      }
    }
  }

  /**
   * Creates an S3 source for the pipeline
   */
  private createS3Source(id: UniqueId): CodePipelineSource {
    const options = this.config.getS3Options();

    const bucket = Bucket.fromBucketName(
      this.scope,
      id.generate('source:bucket'),
      options.bucketName,
    );

    let trigger: S3Trigger;
    switch (options.trigger) {
      case TriggerType.AUTO: trigger = S3Trigger.EVENTS; break;
      case TriggerType.SCHEDULE: trigger = S3Trigger.NONE; break;
      default: trigger = S3Trigger.NONE;
    }

    return CodePipelineSource.s3(bucket, options.objectKey, { trigger });
  }

  /**
   * Creates a GitHub source for the pipeline
   */
  private createGitHubSource(): CodePipelineSource {
    const options = this.config.getGitHubOptions();

    const authentication = options.token
      ? (typeof options.token === 'string' ? SecretValue.unsafePlainText(options.token) : options.token)
      : undefined;

    return CodePipelineSource.gitHub(options.repo, options.branch, {
      trigger: options.trigger === TriggerType.AUTO ? GitHubTrigger.POLL : GitHubTrigger.NONE,
      authentication,
    });
  }

  /**
   * Creates a CodeStar connection source for the pipeline
   */
  private createCodeStarSource(): CodePipelineSource {
    const options = this.config.getCodeStarOptions();

    return CodePipelineSource.connection(options.repo, options.branch, {
      connectionArn: unwrapSecret(options.connectionArn),
      triggerOnPush: options.trigger === TriggerType.AUTO,
      codeBuildCloneOutput: options.codeBuildCloneOutput,
    });
  }

  /**
   * Creates a CodeCommit source for the pipeline
   */
  private createCodeCommitSource(id: UniqueId): CodePipelineSource {
    const options = this.config.getCodeCommitOptions();

    const repository = Repository.fromRepositoryName(
      this.scope,
      id.generate('source:repo'),
      options.repositoryName,
    );

    return CodePipelineSource.codeCommit(repository, options.branch ?? 'main', {
      trigger: options.trigger === TriggerType.AUTO ? CodeCommitTrigger.EVENTS : CodeCommitTrigger.NONE,
    });
  }
}
