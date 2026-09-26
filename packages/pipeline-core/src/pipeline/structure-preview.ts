// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The concrete shape a pipeline configuration will synthesize to — stages, the
 * plugins each one runs, the deploys, and how its IAM role is obtained —
 * WITHOUT importing `aws-cdk-lib` or synthesizing anything.
 *
 * Exists so a reviewer approves something concrete. `POST /pipelines/validate`
 * and the create response previously answered only "valid/invalid": a reviewer
 * asked to sign off on a pipeline had to read raw `props` JSON and work out what
 * it would build, and an update gave no indication of what it CHANGED. This is
 * the summary those responses carry, plus {@link diffStructure} for the update
 * case.
 *
 * It is a projection of the config, not a CloudFormation diff: the API has no CDK
 * and cannot know synthesized logical ids. What it does cover is what reviewers
 * actually ask about — which stages exist, in what order, running which plugin
 * versions, which stages deploy where, and whether the pipeline takes a
 * caller-supplied IAM role.
 */

import { codePipelineStageName, describeDeployAttribution, type DeployAttribution, type DeployAttributionInput } from './deploy-attribution.js';

/** One plugin step, as a reviewer reads it. */
export interface PreviewStep {
  /** `publisher/name` when a publisher is declared, else the bare name. */
  readonly plugin: string;
  /** Declared version or range; `latest` when unpinned. */
  readonly version: string;
  /** `pre` (before the deploy) or `post`. */
  readonly position: 'pre' | 'post';
}

/** One stage of the pipeline, in declaration order. */
export interface PreviewStage {
  /** The author's display name. */
  readonly stageName: string;
  /** The name CodePipeline will use — what its events report as `detail.stage`. */
  readonly codePipelineStage: string;
  /** Environment this stage deploys to, when it declares one. */
  readonly environment?: string;
  readonly steps: readonly PreviewStep[];
}

/**
 * How the pipeline obtains its IAM role, and whether that is the caller's choice.
 * `caller-supplied` is the reviewable case: the pipeline assumes a role the config
 * names, so its permissions are whatever that role already holds.
 */
export interface PreviewIam {
  /** The declared `role.type`, or `default` when none is declared. */
  readonly roleType: string;
  /** True when the config names an existing role/ARN rather than taking the default. */
  readonly callerSupplied: boolean;
  /** The named role or ARN, when the config declares one. */
  readonly roleRef?: string;
}

/** Everything the preview reports. */
export interface StructurePreview {
  readonly stages: readonly PreviewStage[];
  readonly deploys: readonly DeployAttribution[];
  readonly iam: PreviewIam;
  /** Distinct `plugin@version` across every stage — the supply-chain surface. */
  readonly plugins: readonly string[];
}

/** The config fields this projection reads. */
interface PreviewInput extends DeployAttributionInput {
  readonly stages?: readonly {
    readonly stageName: string;
    readonly alias?: string;
    readonly environment?: string;
    readonly steps?: readonly {
      readonly plugin?: { readonly name?: string; readonly publisher?: string; readonly filter?: { readonly version?: string } };
      readonly position?: string;
    }[];
  }[];
  readonly role?: { readonly type?: string; readonly options?: Record<string, unknown> };
}

/** `publisher/name` when scoped, else the bare name. */
function pluginRef(plugin: { name?: string; publisher?: string } | undefined): string {
  const name = plugin?.name ?? '(unnamed)';
  return plugin?.publisher ? `${plugin.publisher}/${name}` : name;
}

/**
 * How the role is obtained. `roleArn`/`roleName`/`oidcRole` all mean the pipeline
 * assumes something the config names; only the absent/default case is the
 * platform's own least-privilege role.
 */
function describeIam(role: PreviewInput['role']): PreviewIam {
  const roleType = role?.type ?? 'default';
  const opts = role?.options ?? {};
  const ref = (opts.roleArn ?? opts.roleName ?? opts.roleArnToAssume) as string | undefined;
  return {
    roleType,
    callerSupplied: roleType === 'roleArn' || roleType === 'roleName' || roleType === 'oidcRole',
    ...(ref ? { roleRef: ref } : {}),
  };
}

/** Project a pipeline configuration into the structure it will produce. */
export function previewStructure(props: PreviewInput): StructurePreview {
  const stages: PreviewStage[] = (props.stages ?? []).map((s) => ({
    stageName: s.stageName,
    codePipelineStage: codePipelineStageName(s),
    ...(s.environment ? { environment: s.environment } : {}),
    steps: (s.steps ?? []).map((step) => ({
      plugin: pluginRef(step.plugin),
      // An unpinned plugin resolves to whatever is newest AT SYNTH, which is the
      // single most review-worthy fact about a step — say `latest` rather than
      // omitting it, so a reviewer sees the difference from a pinned version.
      version: step.plugin?.filter?.version ?? 'latest',
      position: step.position === 'post' ? 'post' : 'pre',
    })),
  }));

  const plugins = [...new Set(
    stages.flatMap((s) => s.steps.map((st) => `${st.plugin}@${st.version}`)),
  )].sort();

  return {
    stages,
    deploys: describeDeployAttribution(props).deploys,
    iam: describeIam(props.role),
    plugins,
  };
}

/** What an update would change, relative to the stored configuration. */
export interface StructureDiff {
  /** Stage display names added / removed / kept, in the new config's order. */
  readonly stagesAdded: readonly string[];
  readonly stagesRemoved: readonly string[];
  /** Stages whose step list or environment changed. */
  readonly stagesChanged: readonly string[];
  /** `plugin@version` entries added / removed. */
  readonly pluginsAdded: readonly string[];
  readonly pluginsRemoved: readonly string[];
  /** Set when the IAM role changes — the change most worth a second pair of eyes. */
  readonly iamChanged?: { readonly from: PreviewIam; readonly to: PreviewIam };
  /** True when nothing in the projection differs. */
  readonly unchanged: boolean;
}

/** A stage's comparable identity: its steps in order, plus its environment. */
function stageFingerprint(stage: PreviewStage): string {
  return JSON.stringify([
    stage.environment ?? null,
    stage.codePipelineStage,
    stage.steps.map((s) => [s.plugin, s.version, s.position]),
  ]);
}

/**
 * Diff two projections. Keyed on the author's `stageName`, because that is what a
 * reviewer recognizes — a renamed stage reads as one removed and one added, which
 * is the honest summary (CodePipeline replaces the stage either way).
 */
export function diffStructure(before: StructurePreview, after: StructurePreview): StructureDiff {
  const beforeByName = new Map(before.stages.map((s) => [s.stageName, s]));
  const afterByName = new Map(after.stages.map((s) => [s.stageName, s]));

  const stagesAdded = after.stages.filter((s) => !beforeByName.has(s.stageName)).map((s) => s.stageName);
  const stagesRemoved = before.stages.filter((s) => !afterByName.has(s.stageName)).map((s) => s.stageName);
  const stagesChanged = after.stages
    .filter((s) => {
      const prev = beforeByName.get(s.stageName);
      return prev !== undefined && stageFingerprint(prev) !== stageFingerprint(s);
    })
    .map((s) => s.stageName);

  const beforePlugins = new Set(before.plugins);
  const afterPlugins = new Set(after.plugins);
  const pluginsAdded = after.plugins.filter((p) => !beforePlugins.has(p));
  const pluginsRemoved = before.plugins.filter((p) => !afterPlugins.has(p));

  const iamChanged = JSON.stringify(before.iam) !== JSON.stringify(after.iam)
    ? { from: before.iam, to: after.iam }
    : undefined;

  return {
    stagesAdded,
    stagesRemoved,
    stagesChanged,
    pluginsAdded,
    pluginsRemoved,
    ...(iamChanged ? { iamChanged } : {}),
    unchanged: stagesAdded.length === 0 && stagesRemoved.length === 0 && stagesChanged.length === 0
      && pluginsAdded.length === 0 && pluginsRemoved.length === 0 && iamChanged === undefined,
  };
}
