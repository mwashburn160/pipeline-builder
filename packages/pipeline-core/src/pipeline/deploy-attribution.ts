// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What DORA deploy signal a pipeline's configuration will produce — derived
 * WITHOUT synthesizing, and WITHOUT importing `aws-cdk-lib`.
 *
 * CDK-free on purpose. `pipeline-builder.ts` is only reachable through the
 * `/cdk` subpath, so an API route that wanted to tell an author "this deploy was
 * attributed to a stage you didn't name" would have had to pull the whole CDK
 * type graph into the service. The derivation lives here, the construct imports
 * it, and `POST /pipelines` and `POST /pipelines/validate` answer from the same
 * code that stamps the tag.
 */

/** AWS's hard limit on a tag VALUE. */
export const MAX_TAG_VALUE_LENGTH = 256;

/** One `<stage>:<environment>` pair, kept with its raw env for cap prioritization. */
export interface DeployPair {
  readonly str: string;
  readonly env: string;
}

/** The fields of a stage this derivation reads. */
export interface DeployAttributionStage {
  readonly stageName: string;
  readonly alias?: string;
  readonly environment?: string;
}

/** The slice of `BuilderProps` this derivation reads. */
export interface DeployAttributionInput {
  readonly stages?: readonly DeployAttributionStage[];
  readonly environment?: string;
}

/** A DORA deploy the pipeline will report: which stage, to which environment. */
export interface DeployAttribution {
  /** CodePipeline stage name the deploy is attributed to. */
  readonly stage: string;
  /** Environment that stage deploys to. */
  readonly environment: string;
  /**
   * Whether the environment came from a per-stage `environment` (precise) or was
   * inferred from the pipeline-level one (a guess worth warning about).
   */
  readonly inferred: boolean;
}

/** Why a deploy signal may be wrong or missing, for the create/validate response. */
export interface DeployAttributionWarning {
  readonly code: 'inferred-stage' | 'pairs-dropped';
  readonly message: string;
}

/** The full answer: the tag value, the deploys it encodes, and the caveats. */
export interface DeployAttributionReport {
  /** The `pb.deploys` tag value, or undefined when nothing declares an environment. */
  readonly deploysTag?: string;
  readonly deploys: readonly DeployAttribution[];
  readonly warnings: readonly DeployAttributionWarning[];
}

/**
 * The name CodePipeline gives a configured stage: the wave id, i.e. the stage's
 * `alias`, else `<stageName>-alias`. This — not `stageName` — is what appears as
 * `detail.stage` in CodePipeline events, so anything that must MATCH those
 * events (the `pb.deploys` DORA tag) has to be built from this one function.
 */
export function codePipelineStageName(stage: Pick<DeployAttributionStage, 'stageName' | 'alias'>): string {
  return stage.alias ?? `${stage.stageName}-alias`;
}

/** Strip characters AWS rejects in a tag value, and the `+`/`:` this format uses. */
function tagSafeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._/@=-]/g, '-');
}

/**
 * Join `pb.deploys` pairs with `+`, capped at {@link MAX_TAG_VALUE_LENGTH}. When
 * the full value would exceed the cap, the headline/production pair is placed
 * first and only the leading pairs that fit are kept; the trailing overflow pairs
 * are returned in `dropped` for the caller to warn about. Never emits more than
 * 256 chars.
 */
function capDeploysValue(pairs: readonly DeployPair[]): { value: string; dropped: string[] } {
  const full = pairs.map(p => p.str).join('+');
  if (full.length <= MAX_TAG_VALUE_LENGTH) return { value: full, dropped: [] };

  // Prioritize the headline pair — the production deploy if present, else the
  // first pair — so a cap never drops the most operationally-significant deploy.
  const headlineIdx = pairs.findIndex(p => p.env.toLowerCase() === 'production');
  const ordered = headlineIdx > 0
    ? [pairs[headlineIdx], ...pairs.filter((_, i) => i !== headlineIdx)]
    : pairs;

  const kept: string[] = [];
  const dropped: string[] = [];
  for (const p of ordered) {
    const candidate = kept.length === 0 ? p.str : `${kept.join('+')}+${p.str}`;
    if (candidate.length <= MAX_TAG_VALUE_LENGTH) {
      kept.push(p.str);
    } else {
      dropped.push(p.str);
    }
  }
  return { value: kept.join('+'), dropped };
}

/**
 * Derive the `pb.deploys` tag and the deploys it encodes.
 *
 * A stage is a deploy iff it declares an `environment`. Precedence:
 *  - Multi-env: any stage with a per-stage `environment` — list each such stage.
 *  - Single-env: no per-stage environment but a pipeline-level `environment` —
 *    attribute it to the sole stage, the LAST stage of a multi-stage pipeline
 *    (deploys are conventionally final — reported as `inferred`, with a warning
 *    recommending explicit per-stage `environment`), or a literal `Deploy:<env>`
 *    when there are no stages to name.
 *
 * `deploysTag` is undefined when nothing declares an environment: such pipelines
 * produce no DORA deploy signal at all.
 */
export function describeDeployAttribution(props: DeployAttributionInput): DeployAttributionReport {
  const stages = props.stages ?? [];
  const stagesWithEnv = stages.filter(s => typeof s.environment === 'string' && s.environment.length > 0);
  const warnings: DeployAttributionWarning[] = [];

  let deploys: DeployAttribution[];
  if (stagesWithEnv.length > 0) {
    deploys = stagesWithEnv.map(s => ({
      stage: codePipelineStageName(s), environment: s.environment as string, inferred: false,
    }));
  } else if (props.environment) {
    let stageName: string;
    let inferred = false;
    if (stages.length === 1) {
      stageName = codePipelineStageName(stages[0]);
    } else if (stages.length > 1) {
      // Pipeline-level environment on a multi-stage pipeline: attribute it to the
      // LAST stage (deploys are conventionally final) rather than an unmatched
      // literal `Deploy`. Warn so authors move to explicit per-stage `environment`.
      stageName = codePipelineStageName(stages[stages.length - 1]);
      inferred = true;
      warnings.push({
        code: 'inferred-stage',
        message:
          `Pipeline-level environment "${props.environment}" attributed to the last stage `
          + `"${stageName}" of a ${stages.length}-stage pipeline. Declare a per-stage `
          + '`environment` on the actual deploy stage(s) for precise DORA attribution.',
      });
    } else {
      stageName = 'Deploy';
    }
    deploys = [{ stage: stageName, environment: props.environment, inferred }];
  } else {
    return { deploys: [], warnings };
  }

  const { value, dropped } = capDeploysValue(
    deploys.map(d => ({ str: `${tagSafeToken(d.stage)}:${tagSafeToken(d.environment)}`, env: d.environment })),
  );
  if (dropped.length > 0) {
    warnings.push({
      code: 'pairs-dropped',
      message:
        `pb.deploys tag value exceeded the ${MAX_TAG_VALUE_LENGTH}-char AWS tag-value limit; `
        + `dropped ${dropped.length} deploy pair(s): ${dropped.join(', ')}. `
        + 'These environments will not produce DORA deploy signals — reduce stage/environment '
        + 'name lengths or split into separate pipelines.',
    });
  }
  return { deploysTag: value, deploys, warnings };
}
