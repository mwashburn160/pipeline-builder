// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tag keys a caller may never set on a pipeline.
 *
 * These carry TENANCY and attribution: the events Lambda reads `pb.pipeline-id`
 * and `pb.deploys` off the stack to decide whose reports an execution belongs
 * to, and `OrgId` drives cost attribution. A caller that can set them can point
 * another org's executions at its own pipeline.
 *
 * Both halves of the defence read this one list:
 *
 * - `BuilderPropsSchema` refuses a reserved key with 400, so the caller finds
 *   out at create time which key was rejected.
 * - `PipelineBuilder` drops them again at synth. A team can use the construct
 *   directly, without the API, so the synth-time filter is the boundary and the
 *   schema is early feedback — neither is sufficient alone.
 *
 * `aws:` is reserved by AWS itself: a tag set containing one fails the
 * CloudFormation call with a confusing error, so it is refused here for clarity.
 *
 * It lives in api-core because pipeline-core depends on api-core, not the other
 * way round; a second copy in pipeline-core could drift from what the API
 * enforces, which is exactly the gap the two checks exist to close.
 */
export const RESERVED_TAG_KEYS: readonly string[] = [
  'OrgId', 'pipeline-builder', 'project', 'organization',
];

/** Reserved tag-key PREFIXES (case-insensitive), matched in addition to the exact keys. */
export const RESERVED_TAG_PREFIXES: readonly string[] = ['pb.', 'aws:'];

/** Whether `key` is a platform- or AWS-reserved tag key that a caller may not set. */
export function isReservedTagKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return RESERVED_TAG_KEYS.some((r) => r.toLowerCase() === k)
    || RESERVED_TAG_PREFIXES.some((p) => k.startsWith(p));
}
