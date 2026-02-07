import { Tags } from 'aws-cdk-lib';
import { GitHubTrigger, S3Trigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PipelineConfiguration } from './pipeline-configuration';
import { PluginLookup } from './plugin-lookup';
import type { SynthOptions } from './step-types';
import { UniqueId } from '../core/id-generator';
import { buildConfigFromMetadata, Namespace } from '../core/metadata';
import { resolveNetwork } from '../core/network';
import type { CodeBuildDefaults } from '../core/network-types';
import { createCodeBuildStep } from '../core/pipeline-helpers';
import type { MetaDataType } from '../core/pipeline-types';
import { TriggerType } from '../core/pipeline-types';
import { resolveRole } from '../core/role';
import type { RoleConfig } from '../core/role-types';
import { resolveSecurityGroup } from '../core/security-group';
import type { SecurityGroupConfig } from '../core/security-group-types';

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

  /**
   * Pipeline-level CodeBuild defaults applied to all CodeBuild actions
   * (synth, self-mutation, asset publishing) via `codeBuildDefaults`.
   */
  readonly defaults?: CodeBuildDefaults;

  /**
   * Optional IAM role for the CodePipeline.
   * When provided, resolves to a CDK IRole and is passed to the CodePipeline construct.
   */
  readonly role?: RoleConfig;

  /**
   * Optional security groups for the CodePipeline's CodeBuild actions.
   * When provided, resolves to CDK ISecurityGroup[] and is included in codeBuildDefaults.
   */
  readonly securityGroups?: SecurityGroupConfig;
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
  public readonly config: PipelineConfiguration;

  constructor(scope: Construct, id: string, props: BuilderProps) {
    super(scope, id);

    // Use PipelineConfiguration for all business logic (validation, sanitization, metadata merging)
    this.config = new PipelineConfiguration(props);

    const uniqueId = new UniqueId(this.config.organization, this.config.project);
    const pluginLookup = new PluginLookup(
      this,
      uniqueId.generate('plugin-lookup'),
      this.config.organization,
      this.config.project,
    );

    // Create source and build step (delegating to config for logic)
    const source = this.createSource(this.config.getSource(), uniqueId);
    const plugin = pluginLookup.plugin(this.config.getPlugin());
    const synth = createCodeBuildStep({
      id: uniqueId.generate('cdk-synth'),
      uniqueId,
      plugin,
      input: source,
      metadata: this.config.mergedMetadata,
      network: this.config.getNetwork(),
      scope: this,
    });

    // Resolve pipeline-level defaults into codeBuildDefaults
    const codeBuildDefaults = this.resolveDefaults(
      this.config.getDefaults(), props.securityGroups, uniqueId,
    );

    // Resolve optional IAM role
    const role = props.role
      ? resolveRole(this, uniqueId, props.role)
      : undefined;

    // Create CodePipeline construct
    this.pipeline = new CodePipeline(this, uniqueId.generate('pipelines:codepipeline'), {
      ...(codeBuildDefaults && { codeBuildDefaults }),
      ...(role && { role }),
      pipelineName: this.config.pipelineName,
      synth,
      ...this.buildPipelineConfig(this.config.mergedMetadata),
    });

    // Apply tags
    Tags.of(this.pipeline).add('project', this.config.project);
    Tags.of(this.pipeline).add('organization', this.config.organization);
  }

  /**
   * Builds CodePipeline configuration from metadata
   */
  private buildPipelineConfig(metadata: MetaDataType) {
    return buildConfigFromMetadata(metadata, Namespace.CODE_PIPELINE);
  }

  /**
   * Resolves CodeBuildDefaults into the shape expected by CDK's codeBuildDefaults.
   * Combines network config (vpc, subnetSelection, securityGroups from network)
   * with standalone security group config into a single codeBuildDefaults object.
   * Metadata is handled separately via the metadata merge chain.
   */
  private resolveDefaults(
    defaults: CodeBuildDefaults | undefined,
    securityGroupConfig: SecurityGroupConfig | undefined,
    uniqueId: UniqueId,
  ): Record<string, unknown> | undefined {
    const networkProps = defaults?.network
      ? resolveNetwork(this, uniqueId, defaults.network)
      : undefined;

    const standaloneSecurityGroups = securityGroupConfig
      ? resolveSecurityGroup(this, uniqueId, securityGroupConfig)
      : undefined;

    if (!networkProps && !standaloneSecurityGroups) return undefined;

    return {
      ...(networkProps && {
        vpc: networkProps.vpc,
        subnetSelection: networkProps.subnetSelection,
      }),
      ...((networkProps?.securityGroups || standaloneSecurityGroups) && {
        securityGroups: [
          ...(networkProps?.securityGroups ?? []),
          ...(standaloneSecurityGroups ?? []),
        ],
      }),
    };
  }

  /**
   * Creates the appropriate CodePipelineSource based on source type
   */
  private createSource(config: SynthOptions['source'], uniqueId: UniqueId): CodePipelineSource {
    switch (config.type) {
      case 's3':
        return this.createS3Source(uniqueId);
      case 'github':
        return this.createGitHubSource();
      case 'codestar':
        return this.createCodeStarSource();
      default:
        const exhaustiveCheck: never = config;
        throw new Error(`Unsupported source type: ${(exhaustiveCheck as any).type}`);
    }
  }

  /**
   * Creates an S3 source for the pipeline (CDK construct creation)
   */
  private createS3Source(uniqueId: UniqueId): CodePipelineSource {
    const options = this.config.getS3Options();

    const bucket = Bucket.fromBucketName(
      this,
      uniqueId.generate('source-bucket'),
      options.bucketName,
    );

    return CodePipelineSource.s3(bucket, options.objectKey, {
      trigger: options.trigger === TriggerType.POLL ? S3Trigger.POLL : S3Trigger.NONE,
    });
  }

  /**
   * Creates a GitHub source for the pipeline (CDK construct creation)
   */
  private createGitHubSource(): CodePipelineSource {
    const options = this.config.getGitHubOptions();
    this.config.validateGitHubRepo(options.repo);

    return CodePipelineSource.gitHub(options.repo, options.branch, {
      trigger: options.trigger === TriggerType.POLL ? GitHubTrigger.POLL : GitHubTrigger.NONE,
      authentication: PipelineConfiguration.resolveSecret(options.token),
    });
  }

  /**
   * Creates a CodeStar connection source for the pipeline (CDK construct creation)
   */
  private createCodeStarSource(): CodePipelineSource {
    const options = this.config.getCodeStarOptions();
    const arn = PipelineConfiguration.extractConnectionArn(options.connectionArn);

    return CodePipelineSource.connection(options.repo, options.branch, {
      connectionArn: arn,
      triggerOnPush: options.trigger === TriggerType.POLL,
      codeBuildCloneOutput: options.codeBuildCloneOutput,
    });
  }
}