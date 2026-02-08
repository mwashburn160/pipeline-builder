import type { ComputeType as CdkComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodePipeline } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PluginLookup } from './plugin-lookup';
import type { StageOptions } from './step-types';
import { UniqueId } from '../core/id-generator';
import { createCodeBuildStep, merge } from '../core/pipeline-helpers';
import type { MetaDataType } from '../core/pipeline-types';

/**
 * Builds and adds pipeline stages (waves) to a CodePipeline.
 *
 * Each stage is resolved from high-level configuration (plugin names)
 * into CDK CodeBuild steps via PluginLookup, then added as a wave.
 *
 * @example
 * ```typescript
 * const stageBuilder = new StageBuilder(this, pluginLookup, uniqueId, mergedMetadata);
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
  constructor(
    private readonly scope: Construct,
    private readonly pluginLookup: PluginLookup,
    private readonly uniqueId: UniqueId,
    private readonly globalMetadata: MetaDataType,
    private readonly defaultComputeType?: CdkComputeType,
  ) {}

  /**
   * Resolves a stage's plugin-based step configs into CodeBuild steps
   * and adds them as a wave to the pipeline.
   */
  addStage(pipeline: CodePipeline, stage: StageOptions): void {
    const waveId = stage.alias ?? `${stage.stageName}-alias`;

    const steps = stage.steps.map(stepConfig => {
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
    });

    pipeline.addWave(waveId, { pre: steps });
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
