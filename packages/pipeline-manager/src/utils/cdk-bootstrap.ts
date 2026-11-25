// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CDK bootstrap a deploy through a runner relies on — shared by
 * `infra setup-runner --enable-deploy` (checks every allowlisted region) and
 * the runner's deploy job (checks its target region; it never bootstraps).
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * The oldest bootstrap the deploy job works with: version 21 gave the deploy
 * role the CLI permissions (DescribeStackEvents, DeleteStack, GetTemplate) the
 * job's stack-state check, its cleanup of a failed first deploy and an
 * undeploy use through that role.
 */
export const MIN_CDK_BOOTSTRAP_VERSION = 21;

/** The SSM parameter the bootstrap stack records its version in. */
export function bootstrapVersionParameter(qualifier: string): string {
  return `/cdk-bootstrap/${qualifier}/version`;
}

/** One of the bootstrap stack's roles: `cdk-<qualifier>-<kind>-role-<account>-<region>`. */
export function cdkBootstrapRoleArn(partition: string, accountId: string, qualifier: string, kind: string, region: string): string {
  return `arn:${partition}:iam::${accountId}:role/cdk-${qualifier}-${kind}-role-${accountId}-${region}`;
}

/** The command an operator runs to bootstrap a region (the CLI's own). */
export function bootstrapCommandHint(region: string, qualifier?: string): string {
  return `pipeline-manager infra bootstrap --region ${region}${qualifier && qualifier !== 'hnb659fds' ? ` --qualifier ${qualifier}` : ''}`;
}

/** The region's bootstrap version, or undefined when the region is not bootstrapped (with this qualifier). */
export async function readBootstrapVersion(region: string, qualifier: string, ssm: { send(c: unknown): Promise<unknown> } = new SSMClient({ region })): Promise<number | undefined> {
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: bootstrapVersionParameter(qualifier) })) as { Parameter?: { Value?: string } };
    const v = Number(out.Parameter?.Value);
    return Number.isFinite(v) ? v : undefined;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}
