// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ISecurityGroup, type IVpc, SecurityGroup, Subnet, type SubnetSelection, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator.js';
import type {
  NetworkConfig,
  SubnetTypeName,
} from './network-types.js';
import { unwrapSecret } from './pipeline-helpers.js';

/**
 * Mapping from string subnet type names to CDK SubnetType enum values
 */
const SUBNET_TYPE_MAP: Record<SubnetTypeName, SubnetType> = {
  PRIVATE_WITH_EGRESS: SubnetType.PRIVATE_WITH_EGRESS,
  PRIVATE_WITH_NAT: SubnetType.PRIVATE_WITH_NAT,
  PRIVATE_ISOLATED: SubnetType.PRIVATE_ISOLATED,
  PUBLIC: SubnetType.PUBLIC,
};

const DEFAULT_SUBNET_TYPE: SubnetTypeName = 'PRIVATE_WITH_EGRESS';

/** Resolved CDK network props ready to spread into CodeBuildStep or codeBuildDefaults */
export interface ResolvedNetwork {
  vpc: IVpc;
  subnetSelection: SubnetSelection;
  securityGroups?: ISecurityGroup[];
}

/**
 * Build a NetworkConfig from environment, for deployments that want EVERY
 * synthesized pipeline's CodeBuild to run inside a VPC (the EC2 "internal" /
 * inside-AWS-only mode) without per-pipeline network config. Returns undefined
 * when the env isn't set — public/default deployments run CodeBuild in the
 * AWS-managed network as before.
 *
 * Env (set on the pipeline service in internal mode):
 *   PIPELINE_VPC_ID              VPC the CodeBuild projects join (required)
 *   PIPELINE_SUBNET_IDS          comma-separated private subnet IDs (required)
 *   PIPELINE_SECURITY_GROUP_IDS  comma-separated SG IDs (optional)
 */
export function networkConfigFromEnv(): NetworkConfig | undefined {
  const vpcId = (process.env.PIPELINE_VPC_ID || '').trim();
  const subnetIds = (process.env.PIPELINE_SUBNET_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!vpcId || subnetIds.length === 0) return undefined;

  const securityGroupIds = (process.env.PIPELINE_SECURITY_GROUP_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return {
    type: 'subnetIds',
    options: {
      vpcId,
      subnetIds,
      ...(securityGroupIds.length > 0 && { securityGroupIds }),
    },
  };
}

/**
 * Resolve a NetworkConfig into CDK props for CodeBuildStep or codeBuildDefaults.
 * Uses discriminated union narrowing to delegate to the appropriate CDK lookups.
 *
 * @param scope - CDK construct scope
 * @param id - UniqueId instance for generating unique construct IDs
 * @param network - Network configuration to resolve
 * @returns Resolved network props ready to spread into CDK constructs
 */
export function resolveNetwork(
  scope: Construct,
  id: UniqueId,
  network: NetworkConfig,
): ResolvedNetwork {
  switch (network.type) {
    case 'subnetIds': {
      const vpc = Vpc.fromLookup(scope, id.generate('network:vpc'), {
        vpcId: unwrapSecret(network.options.vpcId),
      });

      const subnets = network.options.subnetIds.map(
        (subnetId) => Subnet.fromSubnetId(scope, id.generate('network:subnet'), subnetId),
      );

      return withSecurityGroups(
        { vpc, subnetSelection: { subnets } },
        scope,
        id,
        network.options.securityGroupIds,
      );
    }
    case 'vpcId': {
      const vpc = Vpc.fromLookup(scope, id.generate('network:vpc'), {
        vpcId: unwrapSecret(network.options.vpcId),
      });

      return withSecurityGroups(
        { vpc, subnetSelection: resolveSubnetSelection(network.options) },
        scope,
        id,
        network.options.securityGroupIds,
      );
    }
    case 'vpcLookup': {
      const vpc = Vpc.fromLookup(scope, id.generate('network:vpc'), {
        tags: network.options.tags,
        ...(network.options.vpcName && { vpcName: network.options.vpcName }),
        ...(network.options.region && { region: network.options.region }),
      });

      return withSecurityGroups(
        { vpc, subnetSelection: resolveSubnetSelection(network.options) },
        scope,
        id,
        network.options.securityGroupIds,
      );
    }
    default: {
      const _exhaustive: never = network;
      throw new Error(`Unknown network config type: ${(_exhaustive as NetworkConfig).type}`);
    }
  }
}

/**
 * Attach resolved security groups to a network result when present.
 */
function withSecurityGroups(
  result: Omit<ResolvedNetwork, 'securityGroups'>,
  scope: Construct,
  id: UniqueId,
  securityGroupIds?: string[],
): ResolvedNetwork {
  const securityGroups = resolveSecurityGroups(scope, id, securityGroupIds);
  return securityGroups ? { ...result, securityGroups } : result;
}

/**
 * Build a SubnetSelection from options that carry subnetType, availabilityZones,
 * and subnetGroupName. Shared by vpcId and vpcLookup branches.
 */
function resolveSubnetSelection(
  options: { subnetType?: SubnetTypeName; availabilityZones?: string[]; subnetGroupName?: string },
): SubnetSelection {
  return {
    subnetType: SUBNET_TYPE_MAP[options.subnetType ?? DEFAULT_SUBNET_TYPE],
    ...(options.availabilityZones && { availabilityZones: options.availabilityZones }),
    ...(options.subnetGroupName && { subnetGroupName: options.subnetGroupName }),
  };
}

/**
 * Resolve security group IDs into CDK security group references.
 * Returns undefined when no IDs are provided.
 */
function resolveSecurityGroups(
  scope: Construct,
  id: UniqueId,
  securityGroupIds?: string[],
): ISecurityGroup[] | undefined {
  if (!securityGroupIds?.length) {
    return undefined;
  }
  return securityGroupIds.map(
    (sgId) => SecurityGroup.fromSecurityGroupId(scope, id.generate('network:sg'), sgId),
  );
}
