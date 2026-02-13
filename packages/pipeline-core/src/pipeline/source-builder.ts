import { SecretValue } from 'aws-cdk-lib';
import { GitHubTrigger, S3Trigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import type { PipelineConfiguration } from './pipeline-configuration';
import { UniqueId } from '../core/id-generator';
import { unwrapSecret } from '../core/pipeline-helpers';
import { TriggerType } from '../core/pipeline-types';

function isAutoTrigger(trigger: TriggerType): boolean {
  return trigger === TriggerType.AUTO;
}

/**
 * Creates the appropriate CodePipelineSource based on the pipeline configuration.
 *
 * Supports S3, GitHub, and CodeStar connection sources.
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
      default:
        const exhaustiveCheck: never = this.config.source;
        throw new Error(`Unsupported source type: ${exhaustiveCheck}`);
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

    return CodePipelineSource.s3(bucket, options.objectKey, {
      trigger: isAutoTrigger(options.trigger) ? S3Trigger.POLL : S3Trigger.NONE,
    });
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
      trigger: isAutoTrigger(options.trigger) ? GitHubTrigger.POLL : GitHubTrigger.NONE,
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
      triggerOnPush: isAutoTrigger(options.trigger),
      codeBuildCloneOutput: options.codeBuildCloneOutput,
    });
  }
}
