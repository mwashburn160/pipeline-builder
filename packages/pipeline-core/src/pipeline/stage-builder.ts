// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComputeType as CdkComputeType } from 'aws-cdk-lib/aws-codebuild';
import { CodePipeline } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { PluginLookup } from './plugin-lookup.js';
import type { StepManifestRecorder } from './step-manifest-recorder.js';
import type { StageOptions } from './step-types.js';
import { type ArtifactManager } from '../core/artifact-manager.js';
import { UniqueId } from '../core/id-generator.js';
import { merge, resolveFailureBehavior } from '../core/metadata-helpers.js';
import { createCodeBuildStep } from '../core/pipeline-helpers.js';
import type { MetaDataType } from '../core/pipeline-types.js';
import { assertPluginContract, contractScopeFromTemplateScope, pluginArtifactAlias, pluginStepIdAlias } from '../core/plugin-contract.js';

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

  /** Tenant identifier for resolving per-org secrets from AWS Secrets Manager */
  readonly orgId?: string;

  /**
   * Pipeline-level scope used to resolve `{{ pipeline.* }}` template tokens
   * inside plugin specs. Required — passed through to `createCodeBuildStep`
   * on every step.
   */
  readonly pipelineScope: Record<string, unknown>;

  /** Records each step's resolved plugin for the step manifest (W0.1). */
  readonly stepManifest?: StepManifestRecorder;
}

/**
 * The name CodePipeline gives a configured stage: the wave id, i.e. the stage's
 * `alias`, else `<stageName>-alias`. This — not `stageName` — is what appears as
 * `detail.stage` in CodePipeline events, so anything that must MATCH those
 * events (the `pb.deploys` DORA tag) has to be built from this one function.
 */
export function codePipelineStageName(stage: Pick<StageOptions, 'stageName' | 'alias'>): string {
  return stage.alias ?? `${stage.stageName}-alias`;
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
  private readonly orgId?: string;
  private readonly pipelineScope: Record<string, unknown>;
  private readonly stepManifest?: StepManifestRecorder;

  constructor(props: StageBuilderProps) {
    this.scope = props.scope;
    this.pluginLookup = props.pluginLookup;
    this.uniqueId = props.uniqueId;
    this.globalMetadata = props.globalMetadata;
    this.defaultComputeType = props.defaultComputeType;
    this.artifactManager = props.artifactManager;
    this.orgId = props.orgId;
    this.pipelineScope = props.pipelineScope;
    this.stepManifest = props.stepManifest;
  }

  /**
   * Resolves a stage's plugin-based step configs into CodeBuild steps
   * and adds them as a wave to the pipeline.
   */
  addStage(pipeline: CodePipeline, stage: StageOptions): void {
    const stageAlias = codePipelineStageName(stage);

    const preSteps = stage.steps
      .filter(s => (s.position ?? 'pre') === 'pre')
      .map(s => this.resolveStep(s, stage.stageName, stageAlias));
    const postSteps = stage.steps
      .filter(s => s.position === 'post')
      .map(s => this.resolveStep(s, stage.stageName, stageAlias));

    pipeline.addWave(stageAlias, {
      ...(preSteps.length > 0 && { pre: preSteps }),
      ...(postSteps.length > 0 && { post: postSteps }),
    });
  }

  private resolveStep(stepConfig: StageOptions['steps'][number], stageName: string, stageAlias: string) {
    const plugin = this.pluginLookup.plugin(stepConfig.plugin);
    // Contract (W0.2): the pipeline must supply the plugin's required
    // metadata/vars with the declared types. The API refuses such a pipeline
    // at create/update; this stops one that reached synth another way.
    assertPluginContract(plugin, contractScopeFromTemplateScope(this.pipelineScope),
      `${stageName}/${pluginStepIdAlias(stepConfig.plugin)}`);
    // Per-step plugin config lives on the plugin reference (`plugin.metadata` —
    // e.g. JAVA_VERSION/KOTLIN_VERSION/computetype overrides). pluginLookup.plugin()
    // returns the resolved CATALOG plugin and drops the reference metadata in the
    // pre-resolved path, so merge it here too — otherwise per-step overrides are
    // silently ignored and the build falls back to plugin defaults.
    // Order (last wins): global < plugin-ref metadata < step-level metadata.
    const stepMetadata = merge(this.globalMetadata, stepConfig.plugin.metadata ?? {}, stepConfig.metadata ?? {});
    // TWO different identities, deliberately kept apart:
    //  - `stepIdAlias` names the CDK construct. For an unqualified reference
    //    it stays as it always was (`alias ?? name`), because changing it
    //    renames the CodeBuild project's logical id and CloudFormation would
    //    REPLACE every unaliased step's project on the next deploy — for no
    //    benefit. A `publisher` reference adds the publisher (§3.5).
    //  - `pluginAlias` is the ARTIFACT-KEY segment and must follow the one rule
    //    every key consumer uses (`pluginArtifactAlias`). It used to reuse the
    //    construct value, so an unaliased step registered `…:nodejs-build:dist`
    //    while the UI asked for `…:nodejs-build-alias:dist` and synth failed.
    const stepIdAlias = pluginStepIdAlias(stepConfig.plugin);
    const pluginAlias = pluginArtifactAlias(stepConfig.plugin);

    if (stepConfig.inputArtifact && !this.artifactManager) {
      throw new Error(
        `Step "${stepIdAlias}" requires inputArtifact but no artifactManager is configured.`,
      );
    }
    if (stepConfig.additionalInputArtifacts?.length && !this.artifactManager) {
      throw new Error(
        `Step "${stepIdAlias}" requires additionalInputArtifacts but no artifactManager is configured.`,
      );
    }

    const input = stepConfig.inputArtifact && this.artifactManager
      ? this.artifactManager.getOutput(stepConfig.inputArtifact)
      : undefined;

    const additionalInputs = stepConfig.additionalInputArtifacts?.length && this.artifactManager
      ? Object.fromEntries(
        stepConfig.additionalInputArtifacts.map(({ artifact, directory }) => [
          directory || artifact.outputDirectory,
          this.artifactManager!.getOutput(artifact),
        ]),
      )
      : undefined;

    const step = createCodeBuildStep({
      id: this.uniqueId.generate(`stage:${stageAlias}:${stepIdAlias}`),
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
      stageAlias,
      pluginAlias,
      preInstallCommands: stepConfig.preInstallCommands,
      postInstallCommands: stepConfig.postInstallCommands,
      preCommands: stepConfig.preCommands,
      postCommands: stepConfig.postCommands,
      env: stepConfig.env,
      timeout: stepConfig.timeout ?? plugin.timeout ?? undefined,
      // A scan/security-category plugin can never be downgraded from 'fail' — see resolveFailureBehavior.
      failureBehavior: resolveFailureBehavior(plugin.category, stepConfig.failureBehavior ?? plugin.failureBehavior),
      orgId: this.orgId,
      pipelineScope: this.pipelineScope,
    });
    this.stepManifest?.record(step, plugin);
    return step;
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
