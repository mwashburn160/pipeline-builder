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
  /** Post-deploy step to surface (registers admin + loads plugins). */
  readonly postDeploy?: string;
  /** Rough monthly cost (from docs). */
  readonly cost: string;
  /** One-line "best for". */
  readonly bestFor: string;
  /** What a teardown of this target destroys — shown before a (gated) teardown. */
  readonly destroys: string;
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
    required: [],
    optional: [],
    postDeploy: './deploy/bin/init-platform.sh local',
    cost: 'Free',
    bestFor: 'Development',
    destroys: 'stops all containers — data under deploy/local/data persists on disk (delete it manually for a clean slate)',
  },
  minikube: {
    id: 'minikube',
    label: 'Minikube (local Kubernetes)',
    dir: 'deploy/minikube',
    entrypoint: 'bin/setup.sh',
    required: [],
    optional: [],
    postDeploy: './deploy/bin/init-platform.sh minikube',
    cost: 'Free',
    bestFor: 'Local Kubernetes',
    destroys: 'stops the minikube stack — persistent volumes (PVC data) remain until the cluster is deleted',
  },
  ec2: {
    id: 'ec2',
    label: 'AWS EC2 (single Minikube instance behind an ALB)',
    dir: 'deploy/aws/ec2',
    entrypoint: 'bin/setup.sh',
    required: [KEY_PAIR, DOMAIN, HOSTED_ZONE],
    optional: [REGION, DEPLOY_MODE, GHCR_TOKEN, INSTANCE_TYPE, ...EMAIL],
    postDeploy: './deploy/bin/init-platform.sh ec2  # from inside the VPC (SSM)',
    cost: '~$140-265/mo',
    bestFor: 'Dev / staging',
    destroys: 'DELETES the CloudFormation stack: the VPC, EC2 instance, and its EBS data volume (databases, registry, plugin builds). Irreversible.',
  },
  fargate: {
    id: 'fargate',
    label: 'AWS Fargate (serverless ECS, 6 CloudFormation stacks)',
    dir: 'deploy/aws/fargate',
    entrypoint: 'bin/setup.sh',
    required: [DOMAIN, HOSTED_ZONE],
    optional: [REGION, DEPLOY_MODE, GHCR_TOKEN, ...EMAIL],
    postDeploy: './deploy/bin/init-platform.sh fargate  # from a VPC-attached host',
    cost: '~$100-300/mo',
    bestFor: 'Production',
    destroys: 'DELETES all pb-* CloudFormation stacks: EFS data, databases, and registry. Secrets Manager entries are NOT auto-deleted. Irreversible.',
  },
};

export const TARGET_IDS: readonly TargetId[] = ['local', 'minikube', 'ec2', 'fargate'];

export function isTargetId(value: unknown): value is TargetId {
  return typeof value === 'string' && (TARGET_IDS as readonly string[]).includes(value);
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
    const value = spec.secret && mask ? '***' : String(params[spec.key]);
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
