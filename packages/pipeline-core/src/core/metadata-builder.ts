import type { BuildEnvironment } from 'aws-cdk-lib/aws-codebuild';
import type { CodeBuildStepProps, CodePipelineProps, ShellStepProps } from 'aws-cdk-lib/pipelines';
import { CDK_METADATA_PREFIX } from './pipeline-types';
import type { MetaDataType } from './pipeline-types';

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


/**
 * @deprecated Use the standalone metadataForXxx() functions instead.
 */
export class MetadataBuilder {
  constructor(private readonly metadata: MetaDataType) {}
  forCodePipeline(): Partial<CodePipelineProps> { return metadataForCodePipeline(this.metadata); }
  forCodeBuildStep(): Partial<CodeBuildStepProps> { return metadataForCodeBuildStep(this.metadata); }
  forShellStep(): Partial<ShellStepProps> { return metadataForShellStep(this.metadata); }
  forBuildEnvironment(): Partial<BuildEnvironment> { return metadataForBuildEnvironment(this.metadata); }
  static from(metadata: MetaDataType): MetadataBuilder { return new MetadataBuilder(metadata); }
}
