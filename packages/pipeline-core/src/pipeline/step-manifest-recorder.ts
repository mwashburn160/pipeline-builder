// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';
import type { Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import type { Step } from 'aws-cdk-lib/pipelines';
import type { LookupToolchain } from '../core/plugin-lookup-envelope.js';
import {
  BUILD_IMAGE_MANIFEST_ACTION, BUILD_IMAGE_MANIFEST_STAGE, BUILD_IMAGE_STEP_KEY, PLACEHOLDER_PLUGIN_ID,
  type BuildImageManifestEntry, type StepManifestEntry,
} from '../core/step-manifest.js';

/**
 * CDK Pipelines' action-name sanitizer (`pipelines/lib/private/identifiers`,
 * not exported by aws-cdk-lib). Used ONLY as the key that matches a recorded
 * step to an action of the built pipeline — the names that land in the
 * manifest are read off that pipeline. If CDK ever names an action differently
 * (e.g. its >100-char truncation), the step simply goes unmatched and is left
 * out: a missing manifest row, never a wrong one. test/step-manifest.test.ts
 * pins the match against a real synth.
 */
function cdkActionKey(stepId: string): string {
  return stepId.replace(/[^A-Za-z0-9.@\-_]+/g, '_');
}

/**
 * Collects (step → resolved plugin) pairs while the stages are built, then
 * reads the finished CodePipeline to emit the step manifest. Only
 * plugins that were really resolved are recorded — the synth-time
 * `fallback()` / `bootstrap()` placeholders name no `plugins` row.
 */
export class StepManifestRecorder {
  private readonly byActionKey = new Map<string, { plugin: Plugin; stepKey: string }>();
  private buildImage: BuildImageManifestEntry | null = null;

  /** Remember that `step` runs `plugin` under step label `stepKey` (`pluginStepLabel`). Call once per plugin-backed step. */
  record(step: Step, plugin: Plugin, stepKey: string): void {
    if (plugin.id === PLACEHOLDER_PLUGIN_ID) return;
    this.byActionKey.set(cdkActionKey(step.id), { plugin, stepKey });
  }

  /**
   * Remember the pipeline's build image: the toolchain release's
   * `pipeline-bootstrap` half (`plugin`) and the release it resolved to
   * (`toolchain`). Emitted as the non-step `build-image` entry — the synth half
   * of the release is already recorded as the synth step.
   */
  recordBuildImage(plugin: Plugin, toolchain: LookupToolchain): void {
    if (plugin.id === PLACEHOLDER_PLUGIN_ID) return;
    const repository = (plugin as Plugin & { imageRepository?: string | null }).imageRepository ?? null;
    this.buildImage = {
      kind: 'build-image',
      stageName: BUILD_IMAGE_MANIFEST_STAGE,
      actionName: BUILD_IMAGE_MANIFEST_ACTION,
      stepKey: BUILD_IMAGE_STEP_KEY,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
      imageDigest: plugin.imageDigest ?? null,
      releaseVersion: toolchain.releaseVersion,
      imageRepository: repository,
      resolvedVia: toolchain.resolvedVia,
    };
  }

  /**
   * The manifest for the built pipeline. Call after `buildPipeline()`: stage
   * and action names come from `pipeline.stages`, so a stage CDK split for
   * exceeding 50 actions (`<stage>.1`, `<stage>.2`) is reported as CodePipeline
   * reports it. The build-image entry (if recorded) comes last.
   */
  entries(pipeline: Pipeline): StepManifestEntry[] {
    const out: StepManifestEntry[] = [];
    for (const stage of pipeline.stages) {
      for (const action of stage.actions) {
        const actionName = action.actionProperties.actionName;
        const recorded = this.byActionKey.get(actionName);
        if (!recorded) continue;
        const { plugin, stepKey } = recorded;
        out.push({
          stageName: stage.stageName,
          actionName,
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          imageDigest: plugin.imageDigest ?? null,
          stepKey,
        });
      }
    }
    if (this.buildImage) out.push(this.buildImage);
    return out;
  }
}
