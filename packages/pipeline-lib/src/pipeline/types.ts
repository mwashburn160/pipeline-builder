import type { CodeStarSource, GitHubSource, S3Source } from './props';

/**
 * Utility type to extract the union of all values from an object type
 */
type ValueOf<T> = T[keyof T];

/**
 * Access modifier for plugins and resources
 *
 * @property PUBLIC - Accessible to all users and organizations
 * @property PRIVATE - Restricted to specific users or organizations
 */
export const AccessModifier = {
  PUBLIC: 'public',
  PRIVATE: 'private',
} as const;
export type AccessModifier = ValueOf<typeof AccessModifier>;

/**
 * AWS CodeBuild compute resource sizes
 *
 * @property SMALL - 3 GB memory, 2 vCPUs
 * @property MEDIUM - 7 GB memory, 4 vCPUs
 * @property LARGE - 15 GB memory, 8 vCPUs
 * @property X2_LARGE - 145 GB memory, 72 vCPUs
 *
 * @see https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html
 */
export const ComputeType = {
  SMALL: 'SMALL',
  MEDIUM: 'MEDIUM',
  LARGE: 'LARGE',
  X2_LARGE: 'X2_LARGE',
} as const;
export type ComputeType = ValueOf<typeof ComputeType>;

/**
 * Types of pipeline steps that can be created by plugins
 *
 * @property CODE_BUILD_STEP - Full CodeBuild step with custom build environment
 * @property SHELL_STEP - Simple shell step without custom build environment
 */
export const PluginType = {
  CODE_BUILD_STEP: 'CodeBuildStep',
  SHELL_STEP: 'ShellStep',
} as const;
export type PluginType = ValueOf<typeof PluginType>;

/**
 * Pipeline trigger behavior
 *
 * @property NONE - Manual trigger only, pipeline does not start automatically
 * @property POLL - Automatic trigger on source changes (polls source for changes)
 */
export const TriggerType = {
  NONE: 'NONE',
  POLL: 'POLL',
} as const;
export type TriggerType = ValueOf<typeof TriggerType>;

/**
 * Union type of all supported pipeline source types
 *
 * Supported sources:
 * - S3Source: Source code from S3 bucket
 * - GitHubSource: Source code from GitHub repository
 * - CodeStarSource: Source code via CodeStar connection (GitHub, Bitbucket, GitLab)
 */
export type SourceType = S3Source | GitHubSource | CodeStarSource;

/**
 * Metadata type for storing configuration and custom properties
 *
 * Supports:
 * - Standard key-value pairs (string, boolean, number)
 * - Custom AWS keys with the pattern `custom:aws:prefix:key`
 *
 * @example
 * ```typescript
 * const metadata: MetaDataType = {
 *   'custom:aws:codepipeline:selfMutation': true,
 *   'custom:aws:build:parallel': true,
 *   BUILD_ENV: 'production',
 *   NODE_VERSION: '18',
 *   ENABLE_CACHE: true,
 *   MAX_RETRIES: 3
 * };
 * ```
 */
export type MetaDataType =
  Record<string, string | boolean | number> &
  { [K in `custom:aws:${string}`]?: unknown };

/**
 * Type guard to check if a value is a valid AccessModifier
 */
export function isAccessModifier(value: unknown): value is AccessModifier {
  return typeof value === 'string' &&
    Object.values(AccessModifier).includes(value as AccessModifier);
}

/**
 * Type guard to check if a value is a valid ComputeType
 */
export function isComputeType(value: unknown): value is ComputeType {
  return typeof value === 'string' &&
    Object.values(ComputeType).includes(value as ComputeType);
}

/**
 * Type guard to check if a value is a valid PluginType
 */
export function isPluginType(value: unknown): value is PluginType {
  return typeof value === 'string' &&
    Object.values(PluginType).includes(value as PluginType);
}

/**
 * Type guard to check if a value is a valid TriggerType
 */
export function isTriggerType(value: unknown): value is TriggerType {
  return typeof value === 'string' &&
    Object.values(TriggerType).includes(value as TriggerType);
}

/**
 * Helper to get all possible values for an enum-like const object
 *
 * @example
 * ```typescript
 * const computeTypes = getEnumValues(ComputeType);
 * // ['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE']
 * ```
 */
export function getEnumValues<T extends Record<string, string>>(
  enumObj: T,
): Array<ValueOf<T>> {
  return Object.values(enumObj) as Array<ValueOf<T>>;
}

/**
 * Helper to check if a string is a valid custom AWS metadata key
 * Custom keys must start with 'custom:aws:' followed by a prefix and key
 *
 * @example
 * ```typescript
 * isCustomKey('custom:aws:codepipeline:selfMutation'); // true
 * isCustomKey('custom:aws:build:parallel'); // true
 * isCustomKey('NODE_VERSION'); // false
 * ```
 */
export function isCustomKey(key: string): key is `custom:aws:${string}` {
  return key.startsWith('custom:aws:') && key.length > 11;
}

/**
 * Helper to validate metadata object structure
 * Ensures all values are of allowed types
 *
 * @throws Error if metadata contains invalid value types
 */
export function validateMetadata(metadata: Record<string, unknown>): asserts metadata is MetaDataType {
  for (const [key, value] of Object.entries(metadata)) {
    const valueType = typeof value;

    if (valueType !== 'string' && valueType !== 'boolean' && valueType !== 'number') {
      throw new Error(
        `Invalid metadata value type for key "${key}". ` +
        `Expected string, boolean, or number, got ${valueType}.`,
      );
    }
  }
}

/**
 * Filter metadata to only include custom AWS keys
 *
 * @example
 * ```typescript
 * const metadata = {
 *   'custom:aws:build:parallel': true,
 *   'NODE_VERSION': '18',
 *   'custom:aws:codepipeline:selfMutation': true
 * };
 *
 * const customOnly = filterCustomKeys(metadata);
 * // {
 * //   'custom:aws:build:parallel': true,
 * //   'custom:aws:codepipeline:selfMutation': true
 * // }
 * ```
 */
export function filterCustomKeys(metadata: MetaDataType): Record<string, unknown> {
  return Object.entries(metadata)
    .filter(([key]) => isCustomKey(key))
    .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
}

/**
 * Filter metadata to exclude custom AWS keys (only standard keys)
 *
 * @example
 * ```typescript
 * const metadata = {
 *   'custom:aws:build:parallel': true,
 *   'NODE_VERSION': '18',
 *   'ENABLE_CACHE': true
 * };
 *
 * const standardOnly = filterStandardKeys(metadata);
 * // {
 * //   'NODE_VERSION': '18',
 * //   'ENABLE_CACHE': true
 * // }
 * ```
 */
export function filterStandardKeys(metadata: MetaDataType): Record<string, string | boolean | number> {
  return Object.entries(metadata)
    .filter(([key]) => !isCustomKey(key))
    .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
}

/**
 * Merge multiple metadata objects, with later objects taking precedence
 *
 * @example
 * ```typescript
 * const base = { NODE_VERSION: '16', 'custom:aws:build:parallel': false };
 * const override = { NODE_VERSION: '18' };
 * const result = mergeMetadata(base, override);
 * // { NODE_VERSION: '18', 'custom:aws:build:parallel': false }
 * ```
 */
export function mergeMetadata(...metadataObjects: MetaDataType[]): MetaDataType {
  return metadataObjects.reduce((acc, curr) => ({ ...acc, ...curr }), {});
}

/**
 * Constants for metadata keys to avoid string typos
 * Use these constants instead of hardcoding strings
 *
 * @example
 * ```typescript
 * const metadata = {
 *   [MetadataKeys.SELF_MUTATION]: true,
 *   [MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL]: true
 * };
 * ```
 */
export const MetadataKeys = {
  // CodePipeline keys
  SELF_MUTATION: 'custom:aws:codepipeline:selfMutation',
  CROSS_ACCOUNT_KEYS: 'custom:aws:codepipeline:crossAccountKeys',
  DOCKER_ENABLED_FOR_SELF_MUTATION: 'custom:aws:codepipeline:dockerEnabledForSelfMutation',
  ENABLE_KEY_ROTATION: 'custom:aws:codepipeline:enableKeyRotation',
  PUBLISH_ASSETS_IN_PARALLEL: 'custom:aws:codepipeline:publishAssetsInParallel',
  REUSE_CROSS_REGION_SUPPORT_STACKS: 'custom:aws:codepipeline:reuseCrossRegionSupportStacks',
  USE_CHANGE_SETS: 'custom:aws:codepipeline:useChangeSets',
  USE_PIPELINE_ROLE_FOR_ACTIONS: 'custom:aws:codepipeline:usePipelineRoleForActions',

  // Build environment keys
  PRIVILEGED: 'custom:aws:buildenvironment:privileged',

  // Custom build keys
  BUILD_PARALLEL: 'custom:aws:build:parallel',
  BUILD_CACHE: 'custom:aws:build:cache',
  BUILD_TIMEOUT: 'custom:aws:build:timeout',
} as const;

/**
 * Type for MetadataKeys values
 */
export type MetadataKey = typeof MetadataKeys[keyof typeof MetadataKeys];