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

export type TargetId = 'docker' | 'minikube' | 'ec2' | 'eks';

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
   * (ec2/eks bind nothing on the operator's machine).
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
// ec2 deploy/teardown stack name (CloudFormation). The `stackName` param key is also reused
// by the teardown path as the resource identifier (ec2 stack / eks cluster name).
const STACK_NAME: InputSpec = { flag: 'stack-name', key: 'stackName', description: 'CloudFormation stack name (default pipeline-builder) — set to run a second ec2 environment' };
// eks cluster name (eksctl). Set to run a second EKS environment in one account.
const CLUSTER_NAME: InputSpec = { flag: 'cluster-name', key: 'clusterName', description: 'EKS cluster name (default pipeline-builder)' };
// Auto-init is ON BY DEFAULT on the AWS targets (ec2 + eks setup.sh default AUTO_INIT=true),
// so `--no-auto-init` is the load-bearing opt-out and `--auto-init` is a no-op reaffirm —
// mirrors --email/--no-email. ec2 self-inits on the instance on first boot; eks self-inits in
// setup.sh's final phase (over a kubectl port-forward). minikube/local run init via provision.
// NOTE: `--no-auto-init`'s key (noAutoInit) is NOT derivable from its flag the way the other
// specs' keys are (commander folds --x/--no-x into a single `x` option); provision.ts assembles
// both keys explicitly — see the param-assembly there.
const AUTO_INIT: InputSpec = { flag: 'auto-init', key: 'autoInit', description: 'ec2/eks: the deploy self-runs init-platform (register + all loads) — the DEFAULT on AWS', boolean: true };
const NO_AUTO_INIT: InputSpec = { flag: 'no-auto-init', key: 'noAutoInit', description: 'ec2/eks: skip the deploy-managed auto-init and run init-platform manually instead', boolean: true };

// SES / email family — shared by ec2 + eks. SES is provisioned BY DEFAULT
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
  docker: {
    id: 'docker',
    label: 'Local (Docker Compose)',
    dir: 'deploy/local/docker',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/local/docker'],
    required: [],
    optional: [],
    postDeploy: './deploy/bin/init-platform.sh docker',
    cost: 'Free',
    bestFor: 'Development',
    deploys: 'the platform as a Docker Compose stack — an nginx TLS proxy, the API services (platform, plugin, pipeline, message, reporting, compliance, quota, billing, image-registry), the frontend, and postgres + mongo + redis. First run pulls the ghcr.io images and generates a local TLS cert (a few minutes).',
    destroys: 'stops all containers — data under deploy/local/docker/data persists on disk (delete it manually for a clean slate)',
    // Mirrors the published ports in deploy/local/docker/docker-compose.yml.
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
    dir: 'deploy/local/minikube',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/local/minikube'],
    required: [],
    optional: [],
    postDeploy: './deploy/bin/init-platform.sh minikube',
    cost: 'Free',
    bestFor: 'Local Kubernetes',
    deploys: 'the platform onto a local Minikube cluster — the same services as Kubernetes Deployments/Services behind an ingress, plus in-cluster postgres + mongo + redis. First run pulls images, builds the cluster, and generates a TLS cert (several minutes).',
    destroys: 'stops the minikube stack — persistent volumes (PVC data) remain until the cluster is deleted',
    // Mirrors the kubectl port-forwards started in deploy/local/minikube/bin/setup.sh.
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
    optional: [REGION, DEPLOY_MODE, GHCR_TOKEN, INSTANCE_TYPE, STACK_NAME, AUTO_INIT, NO_AUTO_INIT, ...EMAIL],
    postDeploy: './deploy/bin/init-platform.sh ec2  # auto-runs on the instance by default; --no-auto-init to do it manually',
    cost: '~$140-265/mo',
    bestFor: 'Dev / staging',
    deploys: 'the platform on a single EC2 instance via CloudFormation — a VPC, the instance (running the Minikube stack), an ALB, a Route 53 record + ACM cert for the domain, and (by default) SES email. The instance pulls images on first boot.',
    destroys: 'DELETES the CloudFormation stack: the VPC, EC2 instance, and its EBS data volume (databases, registry, plugin builds). Irreversible.',
    hostPorts: [], // remote (AWS) — binds nothing on the operator's machine
  },
  eks: {
    id: 'eks',
    label: 'AWS EKS Auto Mode (managed Kubernetes)',
    dir: 'deploy/aws/eks',
    entrypoint: 'bin/setup.sh',
    sparsePaths: ['deploy/aws/eks'],
    required: [DOMAIN, HOSTED_ZONE],
    optional: [REGION, DEPLOY_MODE, GHCR_TOKEN, CLUSTER_NAME, AUTO_INIT, NO_AUTO_INIT, ...EMAIL],
    postDeploy: './deploy/bin/init-platform.sh eks  # auto-runs at the end of setup.sh by default; --no-auto-init to do it manually',
    cost: '~$150-400/mo',
    bestFor: 'Production',
    deploys: 'the platform on Amazon EKS Auto Mode — an AWS-managed Kubernetes cluster (Karpenter-scaled EC2 nodes, AWS Load Balancer Controller, EBS/EFS CSI), the same Kubernetes workloads as the other k8s targets, an ALB Ingress + ACM for the domain, and (by default) SES email. Plugin builds run on the in-cluster rootless buildkitd (EC2 nodes allow it).',
    destroys: 'Runs bin/shutdown.sh: DELETES the EKS cluster + nodes (eksctl), the EFS filesystem, and — when --domain is set — the ACM cert + Route 53 alias. EBS volumes on the Retain StorageClass are NOT auto-deleted (reported at the end). Irreversible.',
    hostPorts: [], // remote (AWS) — binds nothing on the operator's machine
  },
};

export const TARGET_IDS: readonly TargetId[] = ['docker', 'minikube', 'ec2', 'eks'];

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
/** EKS cluster name eksctl defaults to. */
const DEFAULT_EKS_CLUSTER = 'pipeline-builder';

/**
 * Assemble the teardown command for a target. Pure and deterministic — mirrors
 * `assembleCommand` for the destroy path. local/minikube STOP the stack
 * (non-destructive — on-disk / PVC data survives); ec2 DELETEs its CloudFormation
 * stack and eks DELETEs its cluster (eksctl) — both irreversible. EC2 `delete-stack`
 * and `eksctl delete cluster` have no native prompt, which is exactly why the agent's
 * typed-confirmation gate is mandatory there.
 */
export function teardownCommand(
  target: TargetId,
  opts: { stackName?: string; clusterName?: string; region?: string; domain?: string; hostedZoneId?: string; assumeYes?: boolean } = {},
): TeardownResult {
  const region = opts.region || process.env.AWS_REGION || 'us-east-1';
  // Anything flowing unquoted into a shell-executed teardown command is rejected
  // for shell metacharacters (mirrors assembleCommand).
  assertShellSafe(region, 'region');
  if (opts.stackName) assertShellSafe(opts.stackName, 'stack-name');
  if (opts.clusterName) assertShellSafe(opts.clusterName, 'cluster-name');
  if (opts.domain) assertShellSafe(opts.domain, 'domain');
  if (opts.hostedZoneId) assertShellSafe(opts.hostedZoneId, 'hosted-zone-id');
  switch (target) {
    case 'docker':
      return { command: 'cd deploy/local/docker && bash bin/shutdown.sh', destructive: false };
    case 'minikube':
      return { command: 'cd deploy/local/minikube && bash bin/shutdown.sh', destructive: false };
    case 'ec2': {
      const stack = opts.stackName || DEFAULT_EC2_STACK;
      return {
        command:
          `aws cloudformation delete-stack --stack-name ${stack} --region ${region} && ` +
          `aws cloudformation wait stack-delete-complete --stack-name ${stack} --region ${region}`,
        destructive: true,
      };
    }
    case 'eks': {
      // eks tears down via bin/shutdown.sh (like local/minikube use bin/shutdown.sh):
      // it deletes the cluster AND the resources eksctl alone would orphan — the EFS
      // filesystem and, when --domain is given, the ACM cert + Route 53 alias. The
      // agent's typed-confirmation gate already ran, so pass --yes to skip the
      // script's own prompt.
      const cluster = opts.clusterName || DEFAULT_EKS_CLUSTER;
      let command = `cd deploy/aws/eks && bash bin/shutdown.sh --cluster-name ${cluster} --region ${region}`;
      if (opts.domain) command += ` --domain ${opts.domain}`;
      if (opts.hostedZoneId) command += ` --hosted-zone-id ${opts.hostedZoneId}`;
      if (opts.assumeYes) command += ' --yes';
      return { command, destructive: true };
    }
  }
}
