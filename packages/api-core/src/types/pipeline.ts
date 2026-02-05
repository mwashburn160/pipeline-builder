/**
 * Shared pipeline types used by both pipeline-core and pipeline-data
 */

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
 * Metadata type for storing configuration and custom properties
 *
 * Supports:
 * - Standard key-value pairs (string, boolean, number)
 * - Custom AWS CDK keys with the pattern `aws:cdk:{namespace}:{key}`
 *   (all lowercase — matches the format produced by `getCustomKey`)
 *
 * @example
 * ```typescript
 * const metadata: MetaDataType = {
 *   BUILD_ENV: 'production',
 *   NODE_VERSION: '18',
 *   ENABLE_CACHE: true,
 *   MAX_RETRIES: 3
 * };
 * ```
 */
export type MetaDataType =
  Record<string, string | boolean | number> &
  { [K in `aws:cdk:${string}`]?: unknown };
