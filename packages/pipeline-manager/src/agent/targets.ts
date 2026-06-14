// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic registry of platform deploy targets — the source of truth the
 * `provision` advisor uses to assemble the EXACT deploy command. The agent is a
 * thin wrapper over the existing deploy scripts; it never reimplements
 * deployment, only validates inputs and assembles the command to run.
 *
 * Keep this in lock-step with the flags the scripts accept — every target's
 * operator entrypoint is `bin/setup.sh` (deploy/<target>/bin/setup.sh).
 */

import { assertShellSafe } from '../config/cli.constants.js';

export type TargetId = 'local' | 'minikube' | 'ec2' | 'fargate';

/** A single input the underlying deploy script accepts. */
export interface InputSpec {
  /** Flag name passed to the script (without the leading `--`). */
  readonly flag: string;
  /** Key on the provision params object. */
  readonly key: string;
  /** Human description — shown when a required input is missing. */
  readonly description: string;
  /** Secret — never printed in the assembled command (masked as `***`). */
  readonly secret?: boolean;
  /** Boolean flag with no value (e.g. `--email`). */
  readonly boolean?: boolean;
}

export interface TargetSpec {
  readonly id: TargetId;
  readonly label: string;
  /** Directory the entrypoint runs from (relative to repo root). */
  readonly dir: string;
  /** Entrypoint script (relative to `dir`). */
  readonly entrypoint: string;
  /** Inputs the script REQUIRES — the advisor reports any that are missing. */
  readonly required: readonly InputSpec[];
  /** Optional inputs, passed through only when provided. */
  readonly optional: readonly InputSpec[];
  /**
   * Repo folder(s) this target's deploy needs, for a sparse `--repo` bootstrap.
   * Combined with COMMON_SPARSE_PATHS and any selected load steps' paths.
   */
  readonly sparsePaths: readonly string[];
  /** Post-deploy step to surface (registers admin + loads plugins). */
  readonly postDeploy?: string;
  /** Rough monthly cost (from docs). */
  readonly cost: string;
  /** One-line "best for". */
  readonly bestFor: string;
  /** What the deploy creates — shown when deploying so "Deploying" isn't opaque. */
  readonly deploys: string;
  /** What a teardown of this target destroys — shown before a (gated) teardown. */
  readonly destroys: string;
  /**
   * Host ports the deploy binds — a FALLBACK only. The live list is DERIVED from the
   * cloned deploy source at runtime (ports.ts `discoverHostPorts`): local from
   * docker-compose.yml's published ports, minikube from setup.sh's port-forwards. This
   * static copy is used only when that source can't be read. Empty for remote targets
   * (ec2/fargate bind nothing on the operator's machine).
   */
  readonly hostPorts: readonly { service: string; port: number }[];
}

// --- Shared input specs -----------------------------------------------------

const DOMAIN: InputSpec = { flag: 'domain', key: 'domain', description: 'Fully-qualified domain name (ALB ACM cert + SES DKIM)' };
const HOSTED_ZONE: InputSpec = { flag: 'hosted-zone-id', key: 'hostedZoneId', description: 'Public Route 53 hosted zone ID authoritative for the domain' };
const GHCR_TOKEN: InputSpec = { flag: 'ghcr-token', key: 'ghcrToken', description: 'GitHub PAT with read:packages (avoids ghcr.io anonymous rate limits)', secret: true };
const REGION: InputSpec = { flag: 'region', key: 'region', description: 'AWS region' };
const DEPLOY_MODE: InputSpec = { flag: 'deploy-mode', key: 'deployMode', description: 'public (internet-facing ALB) or private (internal, default)' };
const KEY_PAIR: InputSpec = { flag: 'key-pair', key: 'keyPair', description: 'EC2 key pair in the region (break-glass serial console; routine access is SSM)' };
const INSTANCE_TYPE: InputSpec = { flag: 'instance-type', key: 'instanceType', description: 'EC2 instance type (default t3.2xlarge)' };

// SES / email family — shared by ec2 + fargate. SES is provisioned BY DEFAULT
// on AWS deploys; `--no-email` is the opt-out (`--email` is a harmless no-op kept
// for back-compat).
const EMAIL: readonly InputSpec[] = [
  { flag: 'email', key: 'email', description: 'Enable SES transactional email (on by default for AWS)', boolean: true },
  { flag: 'no-email', key: 'noEmail', description: 'Skip SES (transactional email is provisioned by default)', boolean: true },
  { flag: 'email-from', key: 'emailFrom', description: 'From address (default noreply@<domain>)' },
  { flag: 'email-from-name', key: 'emailFromName', description: 'Display name on outbound email' },
  { flag: 'alert-email', key: 'alertEmail', description: 'Subscribe an address to the bounce/complaint SNS topic' },
  { flag: 'no-create-ses-identity', key: 'noCreateSesIdentity', description: 'Skip SES identity creation (domain already verified)', boolean: true },
];

// --- Targets ----------------------------------------------------------------

export const TARGETS: Readonly<Record<TargetId, TargetSpec>> = {
  local: {
    id: 'local',
    label: 'Local (Docker Compose)',
    dir: 'deploy/local',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/local'],
    required: [],
    optional: [],
    postDeploy: './deploy/bin/init-platform.sh local',
    cost: 'Free',
    bestFor: 'Development',
    deploys: 'the platform as a Docker Compose stack — an nginx TLS proxy, the API services (platform, plugin, pipeline, message, reporting, compliance, quota, billing, image-registry), the frontend, and postgres + mongo + redis. First run pulls the ghcr.io images and generates a local TLS cert (a few minutes).',
    destroys: 'stops all containers — data under deploy/local/data persists on disk (delete it manually for a clean slate)',
    // Mirrors the published ports in deploy/local/docker-compose.yml.
    hostPorts: [
      { service: 'nginx — HTTPS gateway (UI/API)', port: 8443 },
      { service: 'nginx — HTTP redirect', port: 8080 },
      { service: 'pgAdmin (Postgres UI)', port: 5480 },
      { service: 'Mongo Express (Mongo UI)', port: 27081 },
      { service: 'Docker registry', port: 5000 },
      { service: 'Jaeger (tracing UI)', port: 16686 },
    ],
  },
  minikube: {
    id: 'minikube',
    label: 'Minikube (local Kubernetes)',
    dir: 'deploy/minikube',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/minikube'],
    required: [],
    optional: [],
    postDeploy: './deploy/bin/init-platform.sh minikube',
    cost: 'Free',
    bestFor: 'Local Kubernetes',
    deploys: 'the platform onto a local Minikube cluster — the same services as Kubernetes Deployments/Services behind an ingress, plus in-cluster postgres + mongo + redis. First run pulls images, builds the cluster, and generates a TLS cert (several minutes).',
    destroys: 'stops the minikube stack — persistent volumes (PVC data) remain until the cluster is deleted',
    // Mirrors the kubectl port-forwards started in deploy/minikube/bin/setup.sh.
    hostPorts: [
      { service: 'nginx — HTTPS gateway (UI/API)', port: 8443 },
      { service: 'Mongo Express (Mongo UI)', port: 8081 },
      { service: 'pgAdmin (Postgres UI)', port: 5480 },
    ],
  },
  ec2: {
    id: 'ec2',
    label: 'AWS EC2 (single Minikube instance behind an ALB)',
    dir: 'deploy/aws/ec2',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/aws/ec2'],
    required: [KEY_PAIR, DOMAIN, HOSTED_ZONE],
    optional: [REGION, DEPLOY_MODE, GHCR_TOKEN, INSTANCE_TYPE, ...EMAIL],
    postDeploy: './deploy/bin/init-platform.sh ec2  # from inside the VPC (SSM)',
    cost: '~$140-265/mo',
    bestFor: 'Dev / staging',
    deploys: 'the platform on a single EC2 instance via CloudFormation — a VPC, the instance (running the Minikube stack), an ALB, a Route 53 record + ACM cert for the domain, and (by default) SES email. The instance pulls images on first boot.',
    destroys: 'DELETES the CloudFormation stack: the VPC, EC2 instance, and its EBS data volume (databases, registry, plugin builds). Irreversible.',
    hostPorts: [], // remote (AWS) — binds nothing on the operator's machine
  },
  fargate: {
    id: 'fargate',
    label: 'AWS Fargate (serverless ECS, 6 CloudFormation stacks)',
    dir: 'deploy/aws/fargate',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/aws/fargate'],
    required: [DOMAIN, HOSTED_ZONE],
    optional: [REGION, DEPLOY_MODE, GHCR_TOKEN, ...EMAIL],
    postDeploy: './deploy/bin/init-platform.sh fargate  # from a VPC-attached host',
    cost: '~$100-300/mo',
    bestFor: 'Production',
    deploys: 'the platform on serverless ECS Fargate via 6 CloudFormation stacks — a VPC, an ALB, the ECS services, EFS-backed databases + registry, Route 53 + ACM for the domain, and (by default) SES email. Secrets are generated into Secrets Manager first.',
    destroys: 'DELETES all pb-* CloudFormation stacks: EFS data, databases, and registry. Secrets Manager entries are NOT auto-deleted. Irreversible.',
    hostPorts: [], // remote (AWS) — binds nothing on the operator's machine
  },
};

export const TARGET_IDS: readonly TargetId[] = ['local', 'minikube', 'ec2', 'fargate'];

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === 'string' && (TARGET_IDS as readonly string[]).includes(value);
}

// --- Sparse bootstrap paths -------------------------------------------------

/**
 * Folders every `--repo` bootstrap needs regardless of target: the orchestration
 * scripts. Each target's setup.sh + init-platform.sh live in / drive these.
 * Deliberately minimal — heavier folders (plugins/compliance/samples) are pulled
 * in only when their post-install option is selected (see LOAD_STEPS).
 */
export const COMMON_SPARSE_PATHS: readonly string[] = ['deploy/bin'];

/**
 * Opt-in post-install load steps. Each maps a provision `--with-*` flag to the
 * init-platform env var that enables it AND the repo folder(s) it reads — so the
 * sparse checkout grows exactly with the selected options.
 */
export const LOAD_STEPS = [
  // The plugin build reads deploy/plugins/_base AND deploy/codebuild/bootstrap.
  { id: 'plugins', flag: 'withPlugins', env: 'LOAD_PLUGINS', paths: ['deploy/plugins', 'deploy/codebuild'] },
  { id: 'compliance', flag: 'withCompliance', env: 'LOAD_COMPLIANCE', paths: ['deploy/compliance'] },
  { id: 'samples', flag: 'withSamples', env: 'LOAD_PIPELINES', paths: ['deploy/samples'] },
] as const;

export type LoadStepId = (typeof LOAD_STEPS)[number]['id'];

/**
 * The de-duplicated set of sparse paths for a target plus the enabled load
 * steps: common base ∪ target folder(s) ∪ each enabled step's folder(s).
 */
export function sparsePathsFor(target: TargetId, enabledLoadIds: readonly string[]): string[] {
  const paths = new Set<string>(COMMON_SPARSE_PATHS);
  for (const p of TARGETS[target].sparsePaths) paths.add(p);
  for (const step of LOAD_STEPS) {
    if (enabledLoadIds.includes(step.id)) for (const p of step.paths) paths.add(p);
  }
  return [...paths];
}

export interface AssembleResult {
  /** The exact command to run — secrets masked as `***`. */
  readonly command: string;
  /** Required inputs that were not supplied. */
  readonly missing: readonly InputSpec[];
}

/**
 * Assemble the deploy command for a target from the provided params. Pure and
 * deterministic — no shell, no LLM. Missing required inputs are reported (never
 * guessed). By default secrets are masked (`***`) for DISPLAY; pass `mask: false`
 * to build the real command for EXECUTION — that string must never be logged or
 * shown to the model.
 */
export function assembleCommand(
  target: TargetSpec,
  params: Record<string, unknown>,
  opts: { mask?: boolean } = {},
): AssembleResult {
  const mask = opts.mask ?? true;
  const provided = (spec: InputSpec): boolean => {
    const v = params[spec.key];
    return v !== undefined && v !== '' && v !== false;
  };

  const missing = target.required.filter((spec) => !provided(spec));

  const parts: string[] = [`cd ${target.dir} && bash ${target.entrypoint}`];
  for (const spec of [...target.required, ...target.optional]) {
    if (!provided(spec)) continue;
    if (spec.boolean) {
      parts.push(`--${spec.flag}`);
      continue;
    }
    const raw = String(params[spec.key]);
    // The assembled command is executed via a shell (runScript), so a param
    // value carrying shell metacharacters would be command injection. Validate
    // the REAL value even when masking for display — the executed command uses
    // the unmasked value. Redact secrets so the error never echoes a token.
    assertShellSafe(raw, `--${spec.flag}`, { redactValue: spec.secret });
    const value = spec.secret && mask ? '***' : raw;
    parts.push(`--${spec.flag} ${value}`);
  }

  return { command: parts.join(' \\\n  '), missing };
}

export interface TeardownResult {
  /** The exact teardown command to run. */
  readonly command: string;
  /** Whether this teardown irreversibly destroys data (AWS targets). */
  readonly destructive: boolean;
}

/** CloudFormation stack name the EC2 setup.sh defaults to. */
const DEFAULT_EC2_STACK = 'pipeline-builder';
/** Stack prefix the Fargate teardown.sh defaults to. */
const DEFAULT_FARGATE_PREFIX = 'pb';

/**
 * Assemble the teardown command for a target. Pure and deterministic — mirrors
 * `assembleCommand` for the destroy path. local/minikube STOP the stack
 * (non-destructive — on-disk / PVC data survives); ec2/fargate DELETE their
 * CloudFormation stacks and are irreversible. For Fargate, `assumeYes` forwards
 * the native script's own `--yes` (the agent runs its own typed confirmation
 * first, so the script must not also block on stdin); EC2 `delete-stack` has no
 * native prompt, which is exactly why the agent gate is mandatory there.
 */
export function teardownCommand(
  target: TargetId,
  opts: { stackName?: string; region?: string; assumeYes?: boolean } = {},
): TeardownResult {
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';
  // stackName/region flow unquoted into a shell-executed teardown command —
  // reject shell metacharacters (mirrors assembleCommand).
  assertShellSafe(region, 'region');
  if (opts.stackName) assertShellSafe(opts.stackName, 'stack-name');
  switch (target) {
    case 'local':
      return { command: 'cd deploy/local && bash bin/shutdown.sh', destructive: false };
    case 'minikube':
      return { command: 'cd deploy/minikube && bash bin/shutdown.sh', destructive: false };
    case 'ec2': {
      const stack = opts.stackName || DEFAULT_EC2_STACK;
      return {
        command:
          `aws cloudformation delete-stack --stack-name ${stack} --region ${region} && ` +
          `aws cloudformation wait stack-delete-complete --stack-name ${stack} --region ${region}`,
        destructive: true,
      };
    }
    case 'fargate': {
      const prefix = opts.stackName || DEFAULT_FARGATE_PREFIX;
      return {
        command:
          `cd deploy/aws/fargate && bash bin/teardown.sh --stack-prefix ${prefix} --region ${region}` +
          (opts.assumeYes ? ' --yes' : ''),
        destructive: true,
      };
    }
  }
}
