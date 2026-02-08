import { ISecurityGroup, IVpc, SecurityGroup, Subnet, SubnetSelection, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ConstructId } from './id-generator';
import type {
  NetworkConfig,
  SubnetTypeName,
} from './network-types';
import { unwrapSecret } from './pipeline-helpers';

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
 * Resolve a NetworkConfig into CDK props for CodeBuildStep or codeBuildDefaults.
 * Uses discriminated union narrowing to delegate to the appropriate CDK lookups.
 *
 * @param scope - CDK construct scope
 * @param id - ConstructId instance for generating unique construct IDs
 * @param network - Network configuration to resolve
 * @returns Resolved network props ready to spread into CDK constructs
 */
export function resolveNetwork(
  scope: Construct,
  id: ConstructId,
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
  }
}

/**
 * Attach resolved security groups to a network result when present.
 */
function withSecurityGroups(
  result: Omit<ResolvedNetwork, 'securityGroups'>,
  scope: Construct,
  id: ConstructId,
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
  id: ConstructId,
  securityGroupIds?: string[],
): ISecurityGroup[] | undefined {
  if (!securityGroupIds?.length) {
    return undefined;
  }
  return securityGroupIds.map(
    (sgId) => SecurityGroup.fromSecurityGroupId(scope, id.generate('network:sg'), sgId),
  );
}
