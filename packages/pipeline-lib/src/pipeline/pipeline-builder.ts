import { SecretValue, Tags } from 'aws-cdk-lib';
import { GitHubTrigger, S3Trigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { CoreConstants } from '../config/app-config';
import { createCodeBuildStep, getCustomKey, isTrue, merge } from '../core/pipeline-helpers';
import { PluginLookupConstruct } from './plugin-lookup-construct';
import { CodeStarOptions, GitHubOptions, S3Options, SynthOptions } from './pipeline-types';
import { MetaDataType, TriggerType } from '../core/pipeline-types';
import { UniqueId } from '../core/id-generator';

/**
 * Configuration properties for the Builder construct
 */
export interface BuilderProps {
  /** Project identifier (lowercase alphanumeric with hyphens) */
  readonly project: string;

  /** Organization identifier (lowercase alphanumeric with hyphens) */
  readonly organization: string;

  /** Optional custom pipeline name. Defaults to: {organization}-{project}-pipeline */
  readonly pipelineName?: string;

  /** Global metadata inherited by all pipeline steps */
  readonly global?: MetaDataType;

  /** Synthesis configuration including source and plugin details */
  readonly synth: SynthOptions;
}

/**
 * CDK construct that creates and configures a CodePipeline for continuous deployment.
 *
 * Features:
 * - Multi-source support (S3, GitHub, CodeStar)
 * - Plugin-based build steps
 * - Metadata-driven configuration
 * - Automatic tagging
 *
 * @example
 * ```typescript
 * new Builder(this, 'MyPipeline', {
 *   project: 'my-app',
 *   organization: 'my-org',
 *   synth: {
 *     source: {
 *       type: 'github',
 *       options: { repo: 'owner/repo', branch: 'main' }
 *     },
 *     plugin: { name: 'synth' }
 *   }
 * });
 * ```
 */
export class Builder extends Construct {
  public readonly pipeline: CodePipeline;

  constructor(scope: Construct, id: string, props: BuilderProps) {
    super(scope, id);

    this.validateProps(props);

    const uniqueId = new UniqueId(props.organization, props.project);
    const pluginLookup = new PluginLookupConstruct(this, uniqueId.generate('plugin-lookup'), props.organization, props.project);

    // Merge metadata - merge() function already handles logging
    const global = merge('global', props.global ?? {}, init());
    const merged = merge('synth', props.synth.metadata ?? {}, global);

    // Create source and build step
    const source = this.createSource(props.synth.source, uniqueId);
    const plugin = pluginLookup.plugin(props.synth.plugin);
    const synth = createCodeBuildStep({
      id: uniqueId.generate('synth'),
      plugin,
      input: source,
      metadata: global,
    });

    const pipelineName = props.pipelineName ?? `${props.organization}-${props.project}-pipeline`;

    this.pipeline = new CodePipeline(this, uniqueId.generate('codepipeline'), {
      pipelineName,
      synth,
      ...this.buildPipelineConfig(merged),
    });

    // Apply tags
    Tags.of(this.pipeline).add('project', props.project);
    Tags.of(this.pipeline).add('organization', props.organization);
  }

  /**
   * Validates BuilderProps to ensure all required fields are present and properly formatted
   */
  private validateProps(props: BuilderProps): void {
    const errors: string[] = [];

    if (!props.project) {
      errors.push('BuilderProps.project is required');
    } else if (!CoreConstants.NAME_PATTERN.test(props.project)) {
      errors.push(
        `Invalid project name: "${props.project}". ` +
        'Must contain only lowercase letters, numbers, and hyphens.',
      );
    }

    if (!props.organization) {
      errors.push('BuilderProps.organization is required');
    } else if (!CoreConstants.NAME_PATTERN.test(props.organization)) {
      errors.push(
        `Invalid organization name: "${props.organization}". ` +
        'Must contain only lowercase letters, numbers, and hyphens.',
      );
    }

    if (!props.synth?.source) {
      errors.push('BuilderProps.synth.source is required');
    }

    if (!props.synth?.plugin) {
      errors.push('BuilderProps.synth.plugin is required');
    }

    if (errors.length > 0) {
      throw new Error(
        'Builder validation failed:\n' +
        errors.map(e => `  - ${e}`).join('\n'),
      );
    }
  }

  /**
   * Builds CodePipeline configuration from metadata
   */
  private buildPipelineConfig(metadata: MetaDataType) {
    return {
      crossAccountKeys: isTrue(metadata[getCustomKey('codepipeline', 'crossAccountKeys')]),
      dockerEnabledForSelfMutation: isTrue(metadata[getCustomKey('codepipeline', 'dockerEnabledForSelfMutation')]),
      enableKeyRotation: isTrue(metadata[getCustomKey('codepipeline', 'enableKeyRotation')]),
      publishAssetsInParallel: isTrue(metadata[getCustomKey('codepipeline', 'publishAssetsInParallel')]),
      reuseCrossRegionSupportStacks: isTrue(metadata[getCustomKey('codepipeline', 'reuseCrossRegionSupportStacks')]),
      selfMutation: isTrue(metadata[getCustomKey('codepipeline', 'selfMutation')]),
      useChangeSets: isTrue(metadata[getCustomKey('codepipeline', 'useChangeSets')]),
      usePipelineRoleForActions: isTrue(metadata[getCustomKey('codepipeline', 'usePipelineRoleForActions')]),
    };
  }

  /**
   * Creates the appropriate CodePipelineSource based on source type
   */
  private createSource(config: SynthOptions['source'], uniqueId: UniqueId): CodePipelineSource {
    switch (config.type) {
      case 's3':
        return this.createS3Source(config.options, uniqueId);
      case 'github':
        return this.createGitHubSource(config.options);
      case 'codestar':
        return this.createCodeStarSource(config.options);
      default:
        const exhaustiveCheck: never = config;
        throw new Error(`Unsupported source type: ${(exhaustiveCheck as any).type}`);
    }
  }

  /**
   * Creates an S3 source for the pipeline
   */
  private createS3Source(options: S3Options, uniqueId: UniqueId): CodePipelineSource {
    const { bucketName, objectKey = 'source.zip', trigger } = options;

    if (!bucketName) {
      throw new Error(
        'S3 source configuration error: bucketName is required. ' +
        'Please provide a valid S3 bucket name in your source options.',
      );
    }

    const bucket = Bucket.fromBucketName(
      this,
      uniqueId.generate('source-bucket'),
      bucketName,
    );

    return CodePipelineSource.s3(bucket, objectKey, {
      trigger: trigger === TriggerType.POLL ? S3Trigger.POLL : S3Trigger.NONE,
    });
  }

  /**
   * Creates a GitHub source for the pipeline
   */
  private createGitHubSource(options: GitHubOptions): CodePipelineSource {
    const { repo, branch = 'main', trigger, token } = options;

    if (!repo) {
      throw new Error(
        'GitHub source configuration error: repo is required. ' +
        'Please provide a repository in the format "owner/repo".',
      );
    }

    if (!repo.includes('/')) {
      throw new Error(
        `Invalid GitHub repository format: "${repo}". ` +
        'Expected format: "owner/repo"',
      );
    }

    return CodePipelineSource.gitHub(repo, branch, {
      trigger: trigger === TriggerType.POLL ? GitHubTrigger.POLL : GitHubTrigger.NONE,
      authentication: this.resolveSecret(token),
    });
  }

  /**
   * Creates a CodeStar connection source for the pipeline
   */
  private createCodeStarSource(options: CodeStarOptions): CodePipelineSource {
    const { repo, branch = 'main', connectionArn, trigger, codeBuildCloneOutput = false } = options;

    if (!repo || !connectionArn) {
      throw new Error(
        'CodeStar source configuration error: both repo and connectionArn are required. ' +
        'Please provide a repository and a valid CodeStar connection ARN.',
      );
    }

    const arn = typeof connectionArn === 'string'
      ? connectionArn
      : connectionArn.unsafeUnwrap();

    return CodePipelineSource.connection(repo, branch, {
      connectionArn: arn,
      triggerOnPush: trigger === TriggerType.POLL,
      codeBuildCloneOutput,
    });
  }

  /**
   * Converts a token to SecretValue, handling both string and SecretValue inputs
   */
  private resolveSecret(token: SecretValue | string | undefined): SecretValue | undefined {
    if (!token) return undefined;
    return typeof token === 'string'
      ? SecretValue.unsafePlainText(token)
      : token;
  }
}

/**
 * Initializes default metadata configuration.
 * Override this to provide application-wide defaults.
 *
 * @returns Default metadata object
 */
export function init(): MetaDataType {
  return {
    [getCustomKey('codepipeline', 'selfMutation')]: true,
  };
}