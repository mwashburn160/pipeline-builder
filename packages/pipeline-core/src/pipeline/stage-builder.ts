import type { ComputeType as CdkComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodePipeline } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PluginLookup } from './plugin-lookup';
import type { StageOptions } from './step-types';
import type { ArtifactManager } from '../core/artifact-manager';
import { UniqueId } from '../core/id-generator';
import { createCodeBuildStep, merge } from '../core/pipeline-helpers';
import type { MetaDataType } from '../core/pipeline-types';

/**
 * Configuration properties for the StageBuilder
 */
export interface StageBuilderProps {
  /** CDK construct scope for creating child constructs */
  readonly scope: Construct;

  /** Plugin lookup service for resolving plugin references to CDK constructs */
  readonly pluginLookup: PluginLookup;

  /** Unique ID generator for creating deterministic construct IDs */
  readonly uniqueId: UniqueId;

  /** Global metadata inherited by all stage steps */
  readonly globalMetadata: MetaDataType;

  /** Default CodeBuild compute type for steps that don't specify one */
  readonly defaultComputeType?: CdkComputeType;

  /** Artifact manager for resolving input artifact keys to FileSets */
  readonly artifactManager?: ArtifactManager;
}

/**
 * Builds and adds pipeline stages (waves) to a CodePipeline.
 *
 * Each stage is resolved from high-level configuration (plugin names)
 * into CDK CodeBuild steps via PluginLookup, then added as a wave.
 *
 * @example
 * ```typescript
 * const stageBuilder = new StageBuilder({
 *   scope: this,
 *   pluginLookup,
 *   uniqueId,
 *   globalMetadata: mergedMetadata,
 * });
 * stageBuilder.addStage(pipeline, {
 *   stageName: 'Integration Tests',
 *   alias: 'integration',
 *   steps: [
 *     { plugin: { name: 'jest-integration' } },
 *     { plugin: { name: 'e2e-tests', alias: 'cypress' } },
 *   ],
 * });
 * ```
 */
export class StageBuilder {
  private readonly scope: Construct;
  private readonly pluginLookup: PluginLookup;
  private readonly uniqueId: UniqueId;
  private readonly globalMetadata: MetaDataType;
  private readonly defaultComputeType?: CdkComputeType;
  private readonly artifactManager?: ArtifactManager;

  constructor(props: StageBuilderProps) {
    this.scope = props.scope;
    this.pluginLookup = props.pluginLookup;
    this.uniqueId = props.uniqueId;
    this.globalMetadata = props.globalMetadata;
    this.defaultComputeType = props.defaultComputeType;
    this.artifactManager = props.artifactManager;
  }

  /**
   * Resolves a stage's plugin-based step configs into CodeBuild steps
   * and adds them as a wave to the pipeline.
   */
  addStage(pipeline: CodePipeline, stage: StageOptions): void {
    const waveId = stage.alias ?? `${stage.stageName}-alias`;

    const preSteps = stage.steps
      .filter(s => (s.position ?? 'pre') === 'pre')
      .map(s => this.resolveStep(s, stage.stageName, waveId));
    const postSteps = stage.steps
      .filter(s => s.position === 'post')
      .map(s => this.resolveStep(s, stage.stageName, waveId));

    pipeline.addWave(waveId, {
      ...(preSteps.length > 0 && { pre: preSteps }),
      ...(postSteps.length > 0 && { post: postSteps }),
    });
  }

  private resolveStep(stepConfig: StageOptions['steps'][number], stageName: string, waveId: string) {
    const plugin = this.pluginLookup.plugin(stepConfig.plugin);
    const stepMetadata = merge(this.globalMetadata, stepConfig.metadata ?? {});
    const stepAlias = stepConfig.plugin.alias ?? stepConfig.plugin.name;

    const input = stepConfig.inputArtifact && this.artifactManager
      ? this.artifactManager.getOutput(stepConfig.inputArtifact)
      : undefined;

    const additionalInputs = stepConfig.additionalInputArtifacts && this.artifactManager
      ? Object.fromEntries(
        Object.entries(stepConfig.additionalInputArtifacts)
          .map(([path, key]) => [path, this.artifactManager!.getOutput(key)]),
      )
      : undefined;

    return createCodeBuildStep({
      id: this.uniqueId.generate(`stage:${waveId}:${stepAlias}`),
      uniqueId: this.uniqueId,
      plugin,
      metadata: stepMetadata,
      network: stepConfig.network,
      scope: this.scope,
      defaultComputeType: this.defaultComputeType,
      input,
      additionalInputs,
      artifactManager: this.artifactManager,
      stageName,
      stageAlias: waveId,
      pluginAlias: stepAlias,
      preInstallCommands: stepConfig.preInstallCommands,
      postInstallCommands: stepConfig.postInstallCommands,
      preCommands: stepConfig.preCommands,
      postCommands: stepConfig.postCommands,
      env: stepConfig.env,
      timeout: stepConfig.timeout,
    });
  }

  /**
   * Resolves and adds multiple stages as waves to the pipeline, in order.
   */
  addStages(pipeline: CodePipeline, stages: StageOptions[]): void {
    for (const stage of stages) {
      this.addStage(pipeline, stage);
    }
  }
}
