import type { ComputeType as CdkComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodePipeline } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PluginLookup } from './plugin-lookup';
import type { StageOptions } from './step-types';
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

  constructor(props: StageBuilderProps) {
    this.scope = props.scope;
    this.pluginLookup = props.pluginLookup;
    this.uniqueId = props.uniqueId;
    this.globalMetadata = props.globalMetadata;
    this.defaultComputeType = props.defaultComputeType;
  }

  /**
   * Resolves a stage's plugin-based step configs into CodeBuild steps
   * and adds them as a wave to the pipeline.
   */
  addStage(pipeline: CodePipeline, stage: StageOptions): void {
    const waveId = stage.alias ?? `${stage.stageName}-alias`;

    const resolveStep = (stepConfig: typeof stage.steps[number]) => {
      const plugin = this.pluginLookup.plugin(stepConfig.plugin);
      const stepMetadata = merge(this.globalMetadata, stepConfig.metadata ?? {});
      const stepAlias = stepConfig.plugin.alias ?? stepConfig.plugin.name;

      return createCodeBuildStep({
        id: this.uniqueId.generate(`stage:${waveId}:${stepAlias}`),
        uniqueId: this.uniqueId,
        plugin,
        metadata: stepMetadata,
        network: stepConfig.network,
        scope: this.scope,
        defaultComputeType: this.defaultComputeType,
        preInstallCommands: stepConfig.preInstallCommands,
        postInstallCommands: stepConfig.postInstallCommands,
        preCommands: stepConfig.preCommands,
        postCommands: stepConfig.postCommands,
        env: stepConfig.env,
      });
    };

    const preSteps = stage.steps.filter(s => (s.position ?? 'pre') === 'pre').map(resolveStep);
    const postSteps = stage.steps.filter(s => s.position === 'post').map(resolveStep);

    pipeline.addWave(waveId, {
      ...(preSteps.length > 0 && { pre: preSteps }),
      ...(postSteps.length > 0 && { post: postSteps }),
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
