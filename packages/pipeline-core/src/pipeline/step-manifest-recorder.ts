// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Plugin } from '@pipeline-builder/pipeline-data';
import type { Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import type { Step } from 'aws-cdk-lib/pipelines';
import { PLACEHOLDER_PLUGIN_ID, type StepManifestEntry } from '../core/step-manifest.js';

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
 * reads the finished CodePipeline to emit the step manifest (W0.1). Only
 * plugins that were really resolved are recorded — the synth-time
 * `fallback()` / `bootstrap()` placeholders name no `plugins` row.
 */
export class StepManifestRecorder {
  private readonly byActionKey = new Map<string, Plugin>();

  /** Remember that `step` runs `plugin`. Call once per plugin-backed step. */
  record(step: Step, plugin: Plugin): void {
    if (plugin.id === PLACEHOLDER_PLUGIN_ID) return;
    this.byActionKey.set(cdkActionKey(step.id), plugin);
  }

  /**
   * The manifest for the built pipeline. Call after `buildPipeline()`: stage
   * and action names come from `pipeline.stages`, so a stage CDK split for
   * exceeding 50 actions (`<stage>.1`, `<stage>.2`) is reported as CodePipeline
   * reports it.
   */
  entries(pipeline: Pipeline): StepManifestEntry[] {
    const out: StepManifestEntry[] = [];
    for (const stage of pipeline.stages) {
      for (const action of stage.actions) {
        const actionName = action.actionProperties.actionName;
        const plugin = this.byActionKey.get(actionName);
        if (!plugin) continue;
        out.push({
          stageName: stage.stageName,
          actionName,
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          imageDigest: plugin.imageDigest ?? null,
        });
      }
    }
    return out;
  }
}
