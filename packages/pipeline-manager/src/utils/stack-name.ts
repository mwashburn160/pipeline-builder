// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Keep CDK deployment and platform registration on the same stack name. */
export function pipelineStackName(project: string, organization: string): string {
  // Pipeline identities allow underscores; CloudFormation stack names do not.
  // Keep the original identity for construct naming and pipeline lookup.
  return `${project}-${organization}`.toLowerCase().replace(/_/g, '-');
}
