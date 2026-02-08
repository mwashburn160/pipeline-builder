import type { MetaDataType } from './pipeline-types';

/**
 * Prefix for all generated metadata keys.
 */
const CUSTOM_TAG_PREFIX = 'aws:cdk:';

/**
 * Type-safe namespace constants for metadata configuration.
 */
const NAMESPACE = {
  SHELL_STEP: 'pipelines:shellstep',
  CODE_BUILD_STEP: 'pipelines:codebuildstep',
  BUILD_ENVIRONMENT: 'codebuild:buildenvironment',
  CODE_PIPELINE: 'pipelines:codepipeline',
  NETWORK: 'ec2:network',
  ROLE: 'iam:role',
  SECURITY_GROUP: 'ec2:securitygroup',
} as const;
type Namespace = (typeof NAMESPACE)[keyof typeof NAMESPACE];

/**
 * Key configuration per namespace.
 * Each entry defines which metadata keys are boolean vs passthrough.
 */
interface NamespaceKeyConfig {
  booleanKeys: readonly string[];
  passthroughKeys: readonly string[];
}

/**
 * Metadata-settable keys per namespace.
 *
 * Metadata is spread last in createCodeBuildStep and Builder, so any key
 * listed here will override the corresponding programmatic default when set.
 *
 * Every CDK prop for each construct is represented here — metadata has
 * full override authority.
 */
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
  [NAMESPACE.NETWORK]: {
    booleanKeys: [],
    passthroughKeys: ['type', 'vpcId', 'subnetIds', 'subnetType', 'availabilityZones', 'subnetGroupName', 'securityGroupIds', 'tags', 'vpcName', 'region'],
  },
  [NAMESPACE.ROLE]: {
    booleanKeys: ['mutable'],
    passthroughKeys: ['type', 'roleArn', 'roleName'],
  },
  [NAMESPACE.SECURITY_GROUP]: {
    booleanKeys: ['mutable'],
    passthroughKeys: ['type', 'securityGroupIds', 'securityGroupName', 'vpcId'],
  },
};

const EMPTY_KEY_CONFIG: NamespaceKeyConfig = { booleanKeys: [], passthroughKeys: [] };

function getCustomKey(prefix: string, key: string): string {
  return `${CUSTOM_TAG_PREFIX}${prefix}:${key}`.toLowerCase();
}

function isTrue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
}

function buildConfigFromMetadata(
  metadata: MetaDataType,
  namespace: string,
): Record<string, unknown> {
  const { booleanKeys, passthroughKeys } =
    NAMESPACE_KEY_MAP[namespace as Namespace] ?? EMPTY_KEY_CONFIG;

  const result: Record<string, unknown> = {};

  for (const key of booleanKeys) {
    const raw = metadata[getCustomKey(namespace, key)];
    if (raw !== undefined) {
      result[key] = isTrue(raw);
    }
  }

  for (const key of passthroughKeys) {
    const raw = metadata[getCustomKey(namespace, key)];
    if (raw !== undefined) {
      result[key] = raw;
    }
  }

  return result;
}

/**
 * Fluent API for extracting CDK construct configuration from metadata.
 *
 * @example
 * ```typescript
 * const config = MetadataBuilder.from(metadata).forCodePipeline();
 * // { selfMutation: true }
 * ```
 */
export class MetadataBuilder {
  constructor(private readonly metadata: MetaDataType) {}

  /** Builds configuration for CodePipeline construct */
  forCodePipeline(): Record<string, unknown> {
    return buildConfigFromMetadata(this.metadata, NAMESPACE.CODE_PIPELINE);
  }

  /** Builds configuration for CodeBuildStep construct */
  forCodeBuildStep(): Record<string, unknown> {
    return buildConfigFromMetadata(this.metadata, NAMESPACE.CODE_BUILD_STEP);
  }

  /** Builds configuration for ShellStep construct */
  forShellStep(): Record<string, unknown> {
    return buildConfigFromMetadata(this.metadata, NAMESPACE.SHELL_STEP);
  }

  /** Builds configuration for BuildEnvironment (used in CodeBuildStep) */
  forBuildEnvironment(): Record<string, unknown> {
    return buildConfigFromMetadata(this.metadata, NAMESPACE.BUILD_ENVIRONMENT);
  }

  /** Static factory method to create a builder from metadata */
  static from(metadata: MetaDataType): MetadataBuilder {
    return new MetadataBuilder(metadata);
  }
}
