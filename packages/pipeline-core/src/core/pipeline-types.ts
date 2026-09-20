// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


// Re-export shared types from api-core for convenience
export { ComputeType, PluginType, type MetaDataType, type Visibility } from '@pipeline-builder/api-core';

/**
 * Pipeline trigger behavior.
 *
 * @property NONE - Manual trigger only, pipeline does not start automatically
 * @property AUTO - Automatic trigger on source changes (S3/GitHub: polling, CodeStar: push-based webhook)
 */
export const TriggerType = {
  NONE: 'NONE',
  /** Automatic trigger on source changes. Uses polling for S3/GitHub, push-based webhook for CodeStar. */
  AUTO: 'AUTO',
  /** Scheduled trigger via EventBridge rule. Requires a cron expression in the source options. */
  SCHEDULE: 'SCHEDULE',
} as const;
export type TriggerType = (typeof TriggerType)[keyof typeof TriggerType];


/**
 * Metadata key constants — re-exported from `@pipeline-builder/api-core`, which
 * owns the single catalog the browser's metadata picker reads as well. Importing
 * `MetadataKeys` from `@pipeline-builder/pipeline-core` keeps working.
 *
 * @example
 * ```typescript
 * const metadata = {
 *   [MetadataKeys.SELF_MUTATION]: true,
 *   [MetadataKeys.PUBLISH_ASSETS_IN_PARALLEL]: true
 * };
 * ```
 */
export { MetadataKeys, type MetadataKey } from '@pipeline-builder/api-core';

/**
 * Prefix for AWS CDK metadata keys.
 * Keys with this prefix are handled by the metadata extraction functions
 * (metadataForCodePipeline, etc.) and should NOT be passed as CodeBuild environment variables.
 */
export const CDK_METADATA_PREFIX = 'aws:cdk:';