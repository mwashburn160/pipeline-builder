// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * True on the AWS targets (EC2/EKS), where the per-org `pipeline-manager infra`
 * setup (store-token / setup-events) applies. The target arrives at RUNTIME via
 * `/config` (`useFeatures().deployTarget`), not a `NEXT_PUBLIC_*` build-time
 * inline, because one prebuilt frontend image serves every target.
 */
export function isAwsTarget(target: string | undefined | null): boolean {
  return target === 'aws-ec2' || target === 'aws-eks';
}
