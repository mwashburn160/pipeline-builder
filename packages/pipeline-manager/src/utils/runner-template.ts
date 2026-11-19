// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner stack, completed for one install: `src/templates/runner-stack.json`
 * is deployable on its own for one region and one prefix, but a runner may be
 * allowlisted for several regions and several pipeline-name prefixes — a cross
 * product CloudFormation cannot express. {@link buildRunnerTemplate} fills the
 * `PipelineActions` statement with exactly one ARN per (region, prefix), so the
 * role can act on nothing else, and keys the API Gateway deployment to the IP
 * allowlist; {@link runnerStackParameters} is the matching parameter set. Pure
 * functions: the CLI writes the result to a temp file.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The CodePipeline actions the runner handler calls — exactly these, nothing else on CodePipeline. */
export const RUNNER_PIPELINE_ACTIONS: readonly string[] = [
  'codepipeline:StartPipelineExecution',
  'codepipeline:StopPipelineExecution',
  'codepipeline:GetPipelineExecution',
  'codepipeline:ListTagsForResource',
];

export interface RunnerTemplateOptions {
  regions: string[];
  /** Pipeline-name prefixes; `['*']` = every pipeline in those regions (the CLI requires --yes). */
  prefixes: string[];
  apiGateway?: boolean;
  /** With apiGateway: the source CIDRs its resource policy admits. */
  allowIps?: string[];
}

export interface RunnerStackParamsInput extends RunnerTemplateOptions {
  /** The registered runner's id — always set: a runner is registered before its stack is deployed. */
  runnerId: string;
  platformBaseUrl: string;
  label: string;
  allowIps?: string[];
  version: string;
}

/** CloudFormation stack name for a runner label. */
export function runnerStackName(label: string): string {
  return `pipeline-builder-runner-${label}`;
}

/** Name suffix on the role/function/API (`pipeline-builder-runner-<label>`). */
export function runnerNameSuffix(label: string): string {
  return `-${label}`;
}

/** The CFN-managed function name for a label (keep in sync with runner-stack.json). */
export function runnerFunctionName(label: string): string {
  return `pipeline-builder-runner${runnerNameSuffix(label)}`;
}

/** One `Fn::Sub` ARN per (region, prefix). A `*` prefix grants the region's every pipeline. */
export function pipelineActionResources(regions: string[], prefixes: string[]): Array<{ 'Fn::Sub': string }> {
  if (regions.length === 0) throw new Error('At least one region is required');
  if (prefixes.length === 0) throw new Error('At least one pipeline prefix is required');
  const all = prefixes.includes('*');
  const out: Array<{ 'Fn::Sub': string }> = [];
  for (const region of regions) {
    for (const prefix of all ? ['*'] : prefixes) {
      const name = prefix === '*' ? '*' : `${prefix}*`;
      out.push({ 'Fn::Sub': `arn:\${AWS::Partition}:codepipeline:${region}:\${AWS::AccountId}:${name}` });
    }
  }
  return out;
}

/** Load the base template (src/templates in tests, dist/templates once built). */
export function loadRunnerBaseTemplate(): Record<string, any> {
  return JSON.parse(readFileSync(path.join(__dirname, '../templates/runner-stack.json'), 'utf-8'));
}

/** The runner template for this install: the base with PipelineActions scoped to regions x prefixes. */
export function buildRunnerTemplate(opts: RunnerTemplateOptions, base: Record<string, any> = loadRunnerBaseTemplate()): Record<string, any> {
  const tpl = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  const statements = tpl.Resources.RunnerRole.Properties.Policies[0].PolicyDocument.Statement as Array<Record<string, any>>;
  const actions = statements.find((s) => s.Sid === 'PipelineActions');
  if (!actions) throw new Error('runner-stack.json has no PipelineActions statement');
  actions.Action = [...RUNNER_PIPELINE_ACTIONS];
  actions.Resource = pipelineActionResources(opts.regions, opts.prefixes);
  if (opts.apiGateway) keyApiDeployment(tpl, opts.allowIps ?? []);
  return tpl;
}

/**
 * A REST API's resource policy takes effect only once the API is DEPLOYED, and
 * CloudFormation creates an `AWS::ApiGateway::Deployment` only when its logical
 * id is new. So the deployment is renamed after a hash of the allowlist: a
 * changed `--allow-ip` gets a new deployment (and the stage moves to it) instead
 * of an updated policy that never applies.
 */
function keyApiDeployment(tpl: Record<string, any>, allowIps: string[]): void {
  const hash = createHash('sha256').update([...allowIps].sort().join(',')).digest('hex').slice(0, 12);
  const id = `RunnerApiDeployment${hash}`;
  const resources = tpl.Resources as Record<string, any>;
  resources[id] = resources.RunnerApiDeployment;
  delete resources.RunnerApiDeployment;
  resources.RunnerApiStage.Properties.DeploymentId = { Ref: id };
}

/** `--parameter-overrides` for `aws cloudformation deploy` (Key=Value strings). */
export function runnerStackParameters(p: RunnerStackParamsInput): string[] {
  const params: Record<string, string> = {
    RunnerId: p.runnerId,
    PlatformBaseUrl: p.platformBaseUrl,
    EntryPoint: p.apiGateway ? 'api-gateway' : 'function-url',
    AllowedRegions: p.regions.join(','),
    AllowedPipelinePrefixes: p.prefixes.includes('*') ? '*' : p.prefixes.join(','),
    PipelinePrefix: p.prefixes.includes('*') ? '' : p.prefixes[0]!,
    NameSuffix: runnerNameSuffix(p.label),
    PipelineManagerVersion: p.version,
  };
  if (p.apiGateway && p.allowIps && p.allowIps.length > 0) params.AllowedIps = p.allowIps.join(',');
  return Object.entries(params).map(([k, v]) => `${k}=${v}`);
}
