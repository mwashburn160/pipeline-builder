import { SecretValue, Tags } from 'aws-cdk-lib';
import { GitHubTrigger, S3Trigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { CodeStarOptions, GitHubOptions, S3Options, SynthOptions } from './pipeline-types';
import { PluginLookupConstruct } from './plugin-lookup-construct';
import { UniqueId } from '../core/id-generator';
import { buildConfigFromMetadata, createCodeBuildStep, merge, replaceNonAlphanumeric } from '../core/pipeline-helpers';
import { MetaDataType, TriggerType } from '../core/pipeline-types';

/**
 * Configuration properties for the Builder construct
 */
export interface BuilderProps {
  /** Project identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly project: string;

  /** Organization identifier (will be sanitized to lowercase alphanumeric with underscores) */
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
 * - Automatic sanitization of project and organization names
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

    // Validate required fields first
    this.validateProps(props);

    // Sanitize project and organization names
    const project = replaceNonAlphanumeric(props.project, '_').toLowerCase();
    const organization = replaceNonAlphanumeric(props.organization, '_').toLowerCase();

    const uniqueId = new UniqueId(organization, project);
    const pluginLookup = new PluginLookupConstruct(this, uniqueId.generate('plugin-lookup'), organization, project);

    // Merge metadata - merge() function already handles logging
    const global = merge(init(), props.global ?? {});
    const merged = merge(global, props.synth.metadata ?? {});

    // Create source and build step
    const source = this.createSource(props.synth.source, uniqueId);
    const plugin = pluginLookup.plugin(props.synth.plugin);
    const synth = createCodeBuildStep({
      id: uniqueId.generate('synth'),
      plugin,
      input: source,
      metadata: global,
    });

    const pipelineName = props.pipelineName ?? `${organization}-${project}-pipeline`;

    this.pipeline = new CodePipeline(this, uniqueId.generate('pipelines:codepipeline'), {
      pipelineName,
      synth,
      ...this.buildPipelineConfig(merged),
    });

    // Apply tags
    Tags.of(this.pipeline).add('project', project);
    Tags.of(this.pipeline).add('organization', organization);
  }

  /**
   * Validates BuilderProps to ensure all required fields are present
   */
  private validateProps(props: BuilderProps): void {
    const errors: string[] = [];

    if (!props.project) {
      errors.push('BuilderProps.project is required');
    }

    if (!props.organization) {
      errors.push('BuilderProps.organization is required');
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
    return buildConfigFromMetadata(metadata, 'pipelines:codepipeline', {
      booleanKeys: [
        'crossAccountKeys',
        'dockerEnabledForSelfMutation',
        'publishAssetsInParallel',
        'reuseCrossRegionSupportStacks',
        'role',
        'selfMutation',
        'useChangeSets',
        'usePipelineRoleForActions',
      ],
      passthroughKeys: [
        'artifactBucket',
        'assetPublishingCodeBuildDefaults',
        'cdkAssetsCliVersion',
        'cliVersion',
        'codeBuildDefaults',
        'codePipeline',
        'crossRegionReplicationBuckets',
        'dockerCredentials',
        'dockerEnabledForSynth',
        'enableKeyRotation',
        'pipelineName',
        'pipelineType',
        'selfMutationCodeBuildDefaults',
        'synthCodeBuildDefaults',
      ],
    });
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
  return {};
}