import { Tags } from 'aws-cdk-lib';
import { CodePipeline, type CodeBuildOptions } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PipelineConfiguration } from './pipeline-configuration';
import { PluginLookup } from './plugin-lookup';
import { SourceBuilder } from './source-builder';
import { StageBuilder } from './stage-builder';
import type { StageOptions, SynthOptions } from './step-types';
import { Config } from '../config/app-config';
import { UniqueId } from '../core/id-generator';
import { MetadataBuilder } from '../core/metadata-builder';
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

    const appConfig = Config.get();
    const uniqueId = new UniqueId();
    const pluginLookup = new PluginLookup(
      this,
      uniqueId.generate('plugin:lookup'),
      {
        organization: this.config.organization,
        project: this.config.project,
        platformUrl: appConfig.server.platformUrl,
        uniqueId,
        runtime: appConfig.aws.lambda.runtime,
      },
    );

    // Create source and build step
    const sourceBuilder = new SourceBuilder(this, this.config);
    const source = sourceBuilder.create(uniqueId);
    const plugin = pluginLookup.plugin(this.config.plugin);
    const defaultComputeType = appConfig.aws.codeBuild.computeType;
    const synth = createCodeBuildStep({
      id: uniqueId.generate('cdk:synth'),
      uniqueId,
      plugin,
      input: source,
      metadata: this.config.metadata.merged,
      network: this.config.network,
      scope: this,
      defaultComputeType,
    });

    // Resolve pipeline-level defaults into codeBuildDefaults
    const codeBuildDefaults = this.resolveDefaults(this.config.defaults, uniqueId);

    // Resolve IAM role (defaults to codeBuildDefault if not specified)
    const role = resolveRole(
      this, uniqueId,
      props.role ?? { type: 'codeBuildDefault', options: {} },
    );

    // Create CodePipeline construct
    this.pipeline = new CodePipeline(this, uniqueId.generate('pipelines:codepipeline'), {
      ...(codeBuildDefaults && { codeBuildDefaults }),
      role,
      pipelineName: this.config.pipelineName,
      synth,
      ...MetadataBuilder.from(this.config.metadata.merged).forCodePipeline(),
    });

    // Add stages as waves via StageBuilder
    if (props.stages) {
      const stageBuilder = new StageBuilder(
        this, pluginLookup, uniqueId, this.config.metadata.merged, defaultComputeType,
      );
      stageBuilder.addStages(this.pipeline, props.stages);
    }

    // Apply tags
    Tags.of(this.pipeline).add('project', this.config.project);
    Tags.of(this.pipeline).add('organization', this.config.organization);
  }

  /**
   * Resolves CodeBuildDefaults into the shape expected by CDK's codeBuildDefaults.
   * Combines network config (vpc, subnetSelection, securityGroups from network)
   * with standalone security group config into a single codeBuildDefaults object.
   * Metadata is handled separately via the metadata merge chain.
   */
  private resolveDefaults(
    defaults: CodeBuildDefaults | undefined,
    id: UniqueId,
  ): CodeBuildOptions | undefined {
    const networkProps = defaults?.network
      ? resolveNetwork(this, id, defaults.network)
      : undefined;

    const standaloneSecurityGroups = defaults?.securityGroups
      ? resolveSecurityGroup(this, id, defaults.securityGroups)
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
}
