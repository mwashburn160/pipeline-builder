import type { MetaDataType } from './pipeline-types';

/**
 * Prefix for all generated metadata keys.
 * Used by getCustomKey to build lookup keys like 'aws:cdk:pipelines:codepipeline:selfmutation'.
 */
const CUSTOM_TAG_PREFIX = 'aws:cdk:';

/**
 * Type-safe namespace constants for metadata configuration.
 * Use these instead of raw strings to get compile-time typo detection.
 */
export const Namespace = {
  SHELL_STEP: 'pipelines:shellstep',
  CODE_BUILD_STEP: 'pipelines:codebuildstep',
  BUILD_ENVIRONMENT: 'codebuild:buildenvironment',
  CODE_PIPELINE: 'pipelines:codepipeline',
} as const;
export type Namespace = (typeof Namespace)[keyof typeof Namespace];

/**
 * Generate a custom AWS key with the standard prefix
 */
export function getCustomKey(prefix: string, key: string): string {
  return `${CUSTOM_TAG_PREFIX}${prefix}:${key}`.toLowerCase();
}

/**
 * Check if a value represents true
 */
export function isTrue(value: any): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
}

/**
 * Key configuration per namespace.
 * Each entry defines which metadata keys are boolean vs passthrough
 * for a given namespace prefix.
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
  [Namespace.SHELL_STEP]: {
    booleanKeys: [],
    passthroughKeys: ['additionalInputs', 'commands', 'env', 'envFromCfnOutputs', 'input', 'installCommands', 'primaryOutputDirectory'],
  },
  [Namespace.CODE_BUILD_STEP]: {
    booleanKeys: [],
    passthroughKeys: ['actionRole', 'additionalInputs', 'buildEnvironment', 'cache', 'commands', 'env', 'envFromCfnOutputs', 'fileSystemLocations', 'input', 'installCommands', 'logging', 'partialBuildSpec', 'primaryOutputDirectory', 'projectName', 'role', 'rolePolicyStatements', 'timeout'],
  },
  [Namespace.BUILD_ENVIRONMENT]: {
    booleanKeys: ['privileged'],
    passthroughKeys: ['buildImage', 'certificate', 'computeType', 'dockerServer', 'environmentVariables', 'fleet'],
  },
  [Namespace.CODE_PIPELINE]: {
    booleanKeys: ['crossAccountKeys', 'dockerEnabledForSelfMutation', 'dockerEnabledForSynth', 'enableKeyRotation', 'publishAssetsInParallel', 'reuseCrossRegionSupportStacks', 'selfMutation', 'useChangeSets', 'usePipelineRoleForActions'],
    passthroughKeys: ['artifactBucket', 'assetPublishingCodeBuildDefaults', 'cdkAssetsCliVersion', 'cliVersion', 'codeBuildDefaults', 'codePipeline', 'crossRegionReplicationBuckets', 'dockerCredentials', 'pipelineName', 'pipelineType', 'role', 'selfMutationCodeBuildDefaults', 'synth', 'synthCodeBuildDefaults'],
  },
};

const EMPTY_KEY_CONFIG: NamespaceKeyConfig = { booleanKeys: [], passthroughKeys: [] };

/**
 * Get the key configuration for a namespace.
 * Returns empty arrays for both booleanKeys and passthroughKeys if namespace is not found.
 */
function getNamespaceKeyConfig(namespace: string): NamespaceKeyConfig {
  return NAMESPACE_KEY_MAP[namespace as Namespace] ?? EMPTY_KEY_CONFIG;
}

/**
 * Build configuration object from metadata using a namespace.
 * Looks up booleanKeys and passthroughKeys from the namespace map.
 * If the namespace is not found, returns an empty object.
 *
 * Only includes keys that are present in metadata. Absent keys are
 * omitted so that programmatic defaults set before the spread are
 * preserved when metadata does not explicitly override them.
 *
 * @param metadata - The metadata object to extract values from
 * @param namespace - A Namespace constant (type-safe) or string (for extensibility)
 * @returns Configuration object with extracted values (absent keys omitted)
 */
export function buildConfigFromMetadata(
  metadata: MetaDataType,
  namespace: Namespace | string,
): Record<string, any> {
  const { booleanKeys, passthroughKeys } = getNamespaceKeyConfig(namespace);

  const result: Record<string, any> = {};

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
