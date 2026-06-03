// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BuildEnvironment } from 'aws-cdk-lib/aws-codebuild';
import type { CodeBuildStepProps, CodePipelineProps, ShellStepProps } from 'aws-cdk-lib/pipelines';
import type { NetworkConfig, SubnetTypeName } from './network-types';
import { CDK_METADATA_PREFIX, MetadataKeys } from './pipeline-types';
import type { MetaDataType } from './pipeline-types';
import type { RoleConfig } from './role-types';
import type { SecurityGroupConfig } from './security-group-types';

/**
 * Type-safe namespace constants for metadata configuration.
 */
const NAMESPACE = {
  SHELL_STEP: 'pipelines:shellstep',
  CODE_BUILD_STEP: 'pipelines:codebuildstep',
  BUILD_ENVIRONMENT: 'codebuild:buildenvironment',
  CODE_PIPELINE: 'pipelines:codepipeline',
} as const;
type Namespace = (typeof NAMESPACE)[keyof typeof NAMESPACE];

interface NamespaceKeyConfig {
  booleanKeys: readonly string[];
  passthroughKeys: readonly string[];
}

const NAMESPACE_KEY_MAP: Record<Namespace, NamespaceKeyConfig> = {
  [NAMESPACE.SHELL_STEP]: {
    booleanKeys: [],
    passthroughKeys: ['additionalInputs', 'commands', 'env', 'envFromCfnOutputs', 'input', 'installCommands', 'primaryOutputDirectory'],
  },
  [NAMESPACE.CODE_BUILD_STEP]: {
    booleanKeys: [],
    passthroughKeys: ['actionRole', 'additionalInputs', 'buildEnvironment', 'cache', 'commands', 'env', 'envFromCfnOutputs', 'fileSystemLocations', 'input', 'installCommands', 'logging', 'partialBuildSpec', 'primaryOutputDirectory', 'projectName', 'role', 'rolePolicyStatements', 'timeout'],
  },
  [NAMESPACE.BUILD_ENVIRONMENT]: {
    booleanKeys: ['privileged'],
    passthroughKeys: ['buildImage', 'certificate', 'computeType', 'dockerServer', 'environmentVariables', 'fleet'],
  },
  [NAMESPACE.CODE_PIPELINE]: {
    booleanKeys: ['crossAccountKeys', 'dockerEnabledForSelfMutation', 'dockerEnabledForSynth', 'enableKeyRotation', 'publishAssetsInParallel', 'reuseCrossRegionSupportStacks', 'selfMutation', 'useChangeSets', 'usePipelineRoleForActions'],
    passthroughKeys: ['artifactBucket', 'assetPublishingCodeBuildDefaults', 'cdkAssetsCliVersion', 'cliVersion', 'codeBuildDefaults', 'codePipeline', 'crossRegionReplicationBuckets', 'dockerCredentials', 'pipelineName', 'pipelineType', 'role', 'selfMutationCodeBuildDefaults', 'synth', 'synthCodeBuildDefaults'],
  },
};

const EMPTY_KEY_CONFIG: NamespaceKeyConfig = { booleanKeys: [], passthroughKeys: [] };

function getCustomKey(prefix: string, key: string): string {
  return `${CDK_METADATA_PREFIX}${prefix}:${key}`.toLowerCase();
}

function isTrue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

/** Extract CDK construct config from metadata for a given namespace. */
export function buildConfigFromMetadata(
  metadata: MetaDataType,
  namespace: string,
): Record<string, unknown> {
  const { booleanKeys, passthroughKeys } =
    NAMESPACE_KEY_MAP[namespace as Namespace] ?? EMPTY_KEY_CONFIG;

  const result: Record<string, unknown> = {};

  for (const key of booleanKeys) {
    const raw = metadata[getCustomKey(namespace, key)];
    if (raw !== undefined) result[key] = isTrue(raw);
  }

  for (const key of passthroughKeys) {
    const raw = metadata[getCustomKey(namespace, key)];
    if (raw !== undefined) result[key] = raw;
  }

  return result;
}

/** Extract CodePipeline config from metadata. */
export function metadataForCodePipeline(metadata: MetaDataType): Partial<CodePipelineProps> {
  return buildConfigFromMetadata(metadata, NAMESPACE.CODE_PIPELINE) as Partial<CodePipelineProps>;
}

/** Extract CodeBuildStep config from metadata. */
export function metadataForCodeBuildStep(metadata: MetaDataType): Partial<CodeBuildStepProps> {
  return buildConfigFromMetadata(metadata, NAMESPACE.CODE_BUILD_STEP) as Partial<CodeBuildStepProps>;
}

/** Extract ShellStep config from metadata. */
export function metadataForShellStep(metadata: MetaDataType): Partial<ShellStepProps> {
  return buildConfigFromMetadata(metadata, NAMESPACE.SHELL_STEP) as Partial<ShellStepProps>;
}

/** Extract BuildEnvironment config from metadata. */
export function metadataForBuildEnvironment(metadata: MetaDataType): Partial<BuildEnvironment> {
  return buildConfigFromMetadata(metadata, NAMESPACE.BUILD_ENVIRONMENT) as Partial<BuildEnvironment>;
}

// ---------------------------------------------------------------------------
// Typed-config extractors: ec2:network / iam:role / ec2:securitygroup metadata
// -> the discriminated-union config objects the builder already consumes
// (NetworkConfig / RoleConfig / SecurityGroupConfig). Unlike the namespaces
// above (which map 1:1 to CDK construct props), these feed resolveNetwork /
// resolveRole / resolveSecurityGroup. Each returns undefined when its keys are
// absent, so callers fall through with `prop ?? metadata ?? env` precedence.
// ---------------------------------------------------------------------------

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Accept a JSON array or a comma-separated string -> string[] (undefined if empty). */
function asList(v: unknown): string[] | undefined {
  const items = Array.isArray(v)
    ? v.map(String).map(s => s.trim()).filter(Boolean)
    : typeof v === 'string' && v.trim() !== ''
      ? v.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  return items.length > 0 ? items : undefined;
}

/** Accept a JSON object or a JSON string -> Record<string,string> (undefined if empty). */
function asTags(v: unknown): Record<string, string> | undefined {
  let obj: unknown = v;
  if (typeof v === 'string' && v.trim() !== '') {
    try { obj = JSON.parse(v); } catch { return undefined; }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const entries = Object.entries(obj as Record<string, unknown>).map(([k, val]) => [k, String(val)] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return undefined;
}

/** undefined when the key is absent; otherwise a coerced boolean. */
function asBool(v: unknown): boolean | undefined {
  return v === undefined ? undefined : isTrue(v);
}

/** Coerce a metadata value to a positive integer; undefined if absent/invalid. */
export function asInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Build a NetworkConfig from `ec2:network` metadata keys. The variant comes
 * from NETWORK_TYPE, or is inferred (subnetIds -> subnetIds, tags -> vpcLookup,
 * vpcId -> vpcId). Returns undefined when no usable network metadata is present.
 */
export function networkConfigFromMetadata(metadata: MetaDataType): NetworkConfig | undefined {
  const type = asStr(metadata[MetadataKeys.NETWORK_TYPE]);
  const vpcId = asStr(metadata[MetadataKeys.NETWORK_VPC_ID]);
  const subnetIds = asList(metadata[MetadataKeys.NETWORK_SUBNET_IDS]);
  const subnetType = asStr(metadata[MetadataKeys.NETWORK_SUBNET_TYPE]) as SubnetTypeName | undefined;
  const availabilityZones = asList(metadata[MetadataKeys.NETWORK_AVAILABILITY_ZONES]);
  const subnetGroupName = asStr(metadata[MetadataKeys.NETWORK_SUBNET_GROUP_NAME]);
  const securityGroupIds = asList(metadata[MetadataKeys.NETWORK_SECURITY_GROUP_IDS]);
  const tags = asTags(metadata[MetadataKeys.NETWORK_TAGS]);
  const vpcName = asStr(metadata[MetadataKeys.NETWORK_VPC_NAME]);
  const region = asStr(metadata[MetadataKeys.NETWORK_REGION]);

  const variant = type ?? (subnetIds ? 'subnetIds' : tags ? 'vpcLookup' : vpcId ? 'vpcId' : undefined);

  switch (variant) {
    case 'subnetIds':
      if (!vpcId || !subnetIds) return undefined;
      return { type: 'subnetIds', options: { vpcId, subnetIds, ...(securityGroupIds && { securityGroupIds }) } };
    case 'vpcId':
      if (!vpcId) return undefined;
      return {
        type: 'vpcId',
        options: {
          vpcId,
          ...(subnetType && { subnetType }),
          ...(availabilityZones && { availabilityZones }),
          ...(subnetGroupName && { subnetGroupName }),
          ...(securityGroupIds && { securityGroupIds }),
        },
      };
    case 'vpcLookup':
      if (!tags) return undefined;
      return {
        type: 'vpcLookup',
        options: {
          tags,
          ...(subnetType && { subnetType }),
          ...(availabilityZones && { availabilityZones }),
          ...(subnetGroupName && { subnetGroupName }),
          ...(securityGroupIds && { securityGroupIds }),
          ...(vpcName && { vpcName }),
          ...(region && { region }),
        },
      };
    default:
      return undefined;
  }
}

/**
 * Build a RoleConfig from `iam:role` metadata keys (roleArn / roleName /
 * codeBuildDefault). The 4 keys can't express the full `oidc` option set, so an
 * `oidc` type from metadata is ignored. Returns undefined when no keys are set.
 */
export function roleConfigFromMetadata(metadata: MetaDataType): RoleConfig | undefined {
  const type = asStr(metadata[MetadataKeys.ROLE_TYPE]);
  const roleArn = asStr(metadata[MetadataKeys.ROLE_ARN]);
  const roleName = asStr(metadata[MetadataKeys.ROLE_NAME]);
  const mutable = asBool(metadata[MetadataKeys.ROLE_MUTABLE]);

  const variant = type ?? (roleArn ? 'roleArn' : roleName ? 'roleName' : undefined);

  switch (variant) {
    case 'roleArn':
      if (!roleArn) return undefined;
      return { type: 'roleArn', options: { roleArn, ...(mutable !== undefined && { mutable }) } };
    case 'roleName':
      if (!roleName) return undefined;
      return { type: 'roleName', options: { roleName, ...(mutable !== undefined && { mutable }) } };
    case 'codeBuildDefault':
      return { type: 'codeBuildDefault', options: { ...(roleName && { roleName }) } };
    default:
      return undefined;
  }
}

/**
 * Build a SecurityGroupConfig from `ec2:securitygroup` metadata keys
 * (securityGroupIds / securityGroupLookup). Returns undefined when no keys set.
 */
export function securityGroupConfigFromMetadata(metadata: MetaDataType): SecurityGroupConfig | undefined {
  const type = asStr(metadata[MetadataKeys.SECURITY_GROUP_TYPE]);
  const ids = asList(metadata[MetadataKeys.SECURITY_GROUP_IDS]);
  const mutable = asBool(metadata[MetadataKeys.SECURITY_GROUP_MUTABLE]);
  const name = asStr(metadata[MetadataKeys.SECURITY_GROUP_NAME]);
  const vpcId = asStr(metadata[MetadataKeys.SECURITY_GROUP_VPC_ID]);

  const variant = type ?? (ids ? 'securityGroupIds' : name ? 'securityGroupLookup' : undefined);

  switch (variant) {
    case 'securityGroupIds':
      if (!ids) return undefined;
      return { type: 'securityGroupIds', options: { securityGroupIds: ids, ...(mutable !== undefined && { mutable }) } };
    case 'securityGroupLookup':
      if (!name || !vpcId) return undefined;
      return { type: 'securityGroupLookup', options: { securityGroupName: name, vpcId } };
    default:
      return undefined;
  }
}

/** A CodePipeline V2 pipeline-level variable parsed from `operations.variables`. */
export interface PipelineVariableSpec {
  name: string;
  defaultValue?: string;
  description?: string;
}

/**
 * Parse `operations.variables` metadata into CodePipeline V2 variable specs.
 * Accepts a JSON array (`[{"name":"ENV","default":"prod","description":"..."}]`)
 * or a compact comma-separated `name=default` list (`ENV=prod,REGION=us-east-1`).
 * Entries without a usable name are skipped; returns [] when nothing valid.
 */
export function parsePipelineVariables(value: unknown): PipelineVariableSpec[] {
  if (value === undefined || value === null || value === '') return [];

  // Already an array (JSON-typed metadata) or a JSON-encoded string.
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = value; }
    }
  }

  if (Array.isArray(parsed)) {
    const specs: PipelineVariableSpec[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const name = asStr(e.name);
      if (!name) continue;
      const defaultValue = asStr(e.default) ?? asStr(e.defaultValue);
      const description = asStr(e.description);
      specs.push({ name, ...(defaultValue !== undefined && { defaultValue }), ...(description !== undefined && { description }) });
    }
    return specs;
  }

  // Compact `name=default` comma list.
  if (typeof parsed === 'string') {
    const specs: PipelineVariableSpec[] = [];
    for (const pair of parsed.split(',')) {
      const idx = pair.indexOf('=');
      const name = (idx === -1 ? pair : pair.slice(0, idx)).trim();
      if (!name) continue;
      const defaultValue = idx === -1 ? undefined : pair.slice(idx + 1).trim();
      specs.push({ name, ...(defaultValue ? { defaultValue } : {}) });
    }
    return specs;
  }

  return [];
}
