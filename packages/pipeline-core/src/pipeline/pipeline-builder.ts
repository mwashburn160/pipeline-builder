import { createLogger } from '@mwashburn160/api-core';
import { Tags } from 'aws-cdk-lib';
import { PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import { CodePipeline, type CodeBuildOptions } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PipelineConfiguration } from './pipeline-configuration';
import { PluginLookup } from './plugin-lookup';
import { SourceBuilder } from './source-builder';
import { StageBuilder } from './stage-builder';
import type { StageOptions, SynthOptions } from './step-types';
import { Config, CoreConstants } from '../config/app-config';
import { ArtifactManager } from '../core/artifact-manager';
import { UniqueId } from '../core/id-generator';
import { metadataForCodePipeline } from '../core/metadata-builder';
import { resolveNetwork } from '../core/network';
import type { CodeBuildDefaults } from '../core/network-types';
import { createCodeBuildStep } from '../core/pipeline-helpers';
import type { MetaDataType } from '../core/pipeline-types';
import { resolveRole } from '../core/role';
import type { RoleConfig } from '../core/role-types';
import { resolveSecurityGroup } from '../core/security-group';

/**
 * Configuration properties for the PipelineBuilder construct
 */
export interface BuilderProps {
  /** Project identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly project: string;

  /** Organization identifier (will be sanitized to lowercase alphanumeric with underscores) */
  readonly organization: string;

  /** Tenant identifier for resolving per-org secrets from AWS Secrets Manager */
  readonly orgId?: string;

  /** Pipeline database record ID — injected as PIPELINE_ID env var for autonomous synth */
  readonly pipelineId?: string;

  /** Optional custom pipeline name. Defaults to: {organization}-{project}-pipeline */
  readonly pipelineName?: string;

  /** Global metadata inherited by all pipeline steps */
  readonly global?: MetaDataType;

  /**
   * Pipeline-level CodeBuild defaults applied to all CodeBuild actions
   * (synth, self-mutation, asset publishing) via `codeBuildDefaults`.
   */
  readonly defaults?: CodeBuildDefaults;

  /**
   * Optional IAM role for the CodePipeline.
   * When provided, resolves to a CDK IRole and is passed to the CodePipeline construct.
   * When omitted, CDK auto-creates a role with the correct codepipeline.amazonaws.com principal.
   */
  readonly role?: RoleConfig;

  /** Synthesis configuration including source and plugin details */
  readonly synth: SynthOptions;

  /**
   * Optional pipeline stages, each containing one or more CodeBuild steps.
   * Stages are added as waves to the CodePipeline after the synth step.
   */
  readonly stages?: StageOptions[];
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
 * new PipelineBuilder(this, 'MyPipeline', {
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
export class PipelineBuilder extends Construct {
  public readonly pipeline: CodePipeline;
  public readonly config: PipelineConfiguration;

  constructor(scope: Construct, id: string, props: BuilderProps) {
    super(scope, id);

    // Use PipelineConfiguration for all business logic (validation, sanitization, metadata merging)
    this.config = new PipelineConfiguration(props);

    const serverConfig = Config.get('server');
    const awsConfig = Config.get('aws');
    const uniqueId = new UniqueId();
    const pluginLookup = new PluginLookup(
      this,
      uniqueId.generate('plugin:lookup'),
      {
        organization: this.config.organization,
        project: this.config.project,
        platformUrl: serverConfig.platformUrl,
        uniqueId,
        runtime: awsConfig.lambda.runtime,
        timeout: awsConfig.lambda.timeout,
        reservedConcurrentExecutions: awsConfig.lambda.reservedConcurrentExecutions,
      },
    );

    // Create source and build step
    const sourceBuilder = new SourceBuilder(this, this.config);
    const source = sourceBuilder.create(uniqueId);
    const plugin = pluginLookup.plugin(this.config.plugin);
    const defaultComputeType = awsConfig.codeBuild.computeType;
    const artifactManager = new ArtifactManager();
    const synthAlias = this.config.plugin.alias ?? this.config.plugin.name;
    // Inject platform credentials secret into synth step for autonomous config fetch
    const synthSecrets: Record<string, string> = {};
    const credentialSecretName = `${CoreConstants.SECRETS_PATH_PREFIX}/system/credentials`;
    synthSecrets.PLATFORM_CREDENTIALS = credentialSecretName;

    const synth = createCodeBuildStep({
      ...this.config.synthCustomization,
      id: uniqueId.generate('cdk:synth'),
      uniqueId,
      plugin,
      input: source,
      metadata: this.config.metadata.merged,
      network: this.config.network,
      scope: this,
      defaultComputeType,
      artifactManager,
      stageName: 'no-stage',
      stageAlias: 'no-stage-alias',
      pluginAlias: `${synthAlias}-alias`,
      orgId: props.orgId,
      synthSecrets,
    });

    // Resolve pipeline-level defaults into codeBuildDefaults
    const codeBuildDefaults = this.resolveDefaults(this.config.defaults, uniqueId, props.pipelineId, serverConfig.platformUrl);

    // Resolve IAM role if explicitly provided; otherwise let CDK auto-create
    // the pipeline role with the correct codepipeline.amazonaws.com principal.
    if (props.role?.type === 'codeBuildDefault') {
      createLogger('PipelineBuilder').warn(
        'codeBuildDefault role type uses codebuild.amazonaws.com trust principal — ' +
        'this is not suitable as the pipeline-level role. Consider using roleArn/roleName ' +
        'or omitting the role to let CDK auto-create one with codepipeline.amazonaws.com.',
      );
    }
    const role = props.role
      ? resolveRole(this, uniqueId, props.role)
      : undefined;

    // Create CodePipeline construct
    this.pipeline = new CodePipeline(this, uniqueId.generate('pipelines:codepipeline'), {
      ...(codeBuildDefaults && { codeBuildDefaults }),
      ...(role && { role }),
      pipelineType: PipelineType.V2,
      pipelineName: this.config.pipelineName,
      synth,
      ...metadataForCodePipeline(this.config.metadata.merged),
    });

    // Add stages as waves via StageBuilder
    if (props.stages) {
      const stageBuilder = new StageBuilder({
        scope: this,
        pluginLookup,
        uniqueId,
        globalMetadata: this.config.metadata.merged,
        defaultComputeType,
        artifactManager,
        orgId: props.orgId,
      });
      stageBuilder.addStages(this.pipeline, props.stages);
    }

    // Apply tags
    Tags.of(this.pipeline).add('project', this.config.project);
    Tags.of(this.pipeline).add('organization', this.config.organization);
  }

  /**
   * Resolves CodeBuildDefaults into the shape expected by CDK's codeBuildDefaults.
   * Combines network config, security groups, and pipeline-level environment variables
   * (PIPELINE_ID, PIPELINE_EXECUTION_ID, PLATFORM_BASE_URL) available to all CodeBuild actions.
   */
  private resolveDefaults(
    defaults: CodeBuildDefaults | undefined,
    id: UniqueId,
    pipelineId: string | undefined,
    platformUrl: string,
  ): CodeBuildOptions | undefined {
    const networkProps = defaults?.network
      ? resolveNetwork(this, id, defaults.network)
      : undefined;

    const standaloneSecurityGroups = defaults?.securityGroups
      ? resolveSecurityGroup(this, id, defaults.securityGroups)
      : undefined;

    // Pipeline-level env vars available to all CodeBuild actions
    const pipelineEnvVars: Record<string, { value: string }> = {
      PLATFORM_BASE_URL: { value: platformUrl },
      PIPELINE_EXECUTION_ID: { value: '#{codepipeline.PipelineExecutionId}' },
      ...(pipelineId && { PIPELINE_ID: { value: pipelineId } }),
    };

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
      buildEnvironment: {
        environmentVariables: pipelineEnvVars,
      },
    };
  }
}
