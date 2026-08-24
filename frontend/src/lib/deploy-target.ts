// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment target the frontend runs against, delivered at RUNTIME via `/config`
 * (see `useFeatures().deployTarget`) — NOT a `NEXT_PUBLIC_*` build-time inline,
 * because the frontend ships as one shared prebuilt image across all targets.
 * Lets UI adapt AWS-only content — e.g. the onboarding step's per-org
 * `store-token`/`setup-events` section, which only applies to the EC2/EKS targets.
 */
export type DeployTarget = 'aws-ec2' | 'aws-eks' | 'local' | 'docker' | 'minikube';

/** True on the AWS targets (EC2/EKS), where the per-org `pipeline-manager infra`
 *  setup (store-token / setup-events) applies. */
export function isAwsTarget(target: string | undefined | null): boolean {
  return target === 'aws-ec2' || target === 'aws-eks';
}
