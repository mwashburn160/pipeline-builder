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

/** An AWS region code (`us-east-1`, `ap-southeast-2`, `us-gov-west-1`, `eu-isoe-west-1`). */
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * The CloudFormation console page for a deployed stack, or null when `region`
 * is not a region code. The region becomes the URL's HOST, and it reaches us
 * from the pipeline registry, which stores whatever string the registering
 * caller sent — so a value like `evil.example/x?` must not turn the trusted
 * "View stack in AWS" link into a link to another site.
 */
export function awsStackConsoleUrl(region: string | undefined | null, stackName: string | undefined | null): string | null {
  if (!region || !stackName || !AWS_REGION_RE.test(region)) return null;
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=${encodeURIComponent(stackName)}`;
}
