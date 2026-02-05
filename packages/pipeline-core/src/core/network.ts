import { SecretValue } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SecurityGroup, Subnet, SubnetSelection, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator';
import {
  NetworkConfig,
  SubnetIdsNetwork,
  VpcIdNetwork,
  VpcLookupNetwork,
  SubnetTypeName,
} from './network-types';

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
 * Strategy interface for network resolution.
 * Each network type implements this interface to provide custom resolution logic.
 */
interface NetworkResolver<T extends NetworkConfig = NetworkConfig> {
  /**
   * Resolves a network configuration into CDK constructs
   * @param scope - CDK construct scope
   * @param idGenerator - UniqueId instance for generating unique construct IDs
   * @param network - Network configuration to resolve
   */
  resolve(scope: Construct, idGenerator: UniqueId, network: T): ResolvedNetwork;
}

/**
 * Base resolver with shared security group resolution logic
 */
abstract class BaseNetworkResolver<T extends NetworkConfig> implements NetworkResolver<T> {
  abstract resolve(scope: Construct, idGenerator: UniqueId, network: T): ResolvedNetwork;

  /**
   * Resolves security groups and includes them in the result if present
   */
  protected withSecurityGroups(
    result: Omit<ResolvedNetwork, 'securityGroups'>,
    scope: Construct,
    idGenerator: UniqueId,
    securityGroupIds?: string[],
  ): ResolvedNetwork {
    const securityGroups = resolveSecurityGroups(scope, idGenerator, securityGroupIds);
    return securityGroups ? { ...result, securityGroups } : result;
  }
}

/**
 * Resolver for subnet IDs based network configuration
 */
class SubnetIdsNetworkResolver extends BaseNetworkResolver<SubnetIdsNetwork> {
  resolve(scope: Construct, idGenerator: UniqueId, network: SubnetIdsNetwork): ResolvedNetwork {
    const vpc = Vpc.fromLookup(scope, idGenerator.generate('network:vpc'), {
      vpcId: resolveSecret(network.options.vpcId),
    });

    const subnets = network.options.subnetIds.map(
      (subnetId, i) => Subnet.fromSubnetId(scope, idGenerator.generate(`network:subnet:${i}`), subnetId),
    );

    return this.withSecurityGroups(
      { vpc, subnetSelection: { subnets } },
      scope,
      idGenerator,
      network.options.securityGroupIds,
    );
  }
}

/**
 * Resolver for VPC ID based network configuration
 */
class VpcIdNetworkResolver extends BaseNetworkResolver<VpcIdNetwork> {
  resolve(scope: Construct, idGenerator: UniqueId, network: VpcIdNetwork): ResolvedNetwork {
    const vpc = Vpc.fromLookup(scope, idGenerator.generate('network:vpc'), {
      vpcId: resolveSecret(network.options.vpcId),
    });

    return this.withSecurityGroups(
      {
        vpc,
        subnetSelection: resolveSubnetSelection(network.options),
      },
      scope,
      idGenerator,
      network.options.securityGroupIds,
    );
  }
}

/**
 * Resolver for VPC lookup based network configuration
 */
class VpcLookupNetworkResolver extends BaseNetworkResolver<VpcLookupNetwork> {
  resolve(scope: Construct, idGenerator: UniqueId, network: VpcLookupNetwork): ResolvedNetwork {
    const vpc = Vpc.fromLookup(scope, idGenerator.generate('network:vpc'), {
      tags: network.options.tags,
      ...(network.options.vpcName && { vpcName: network.options.vpcName }),
      ...(network.options.region && { region: network.options.region }),
    });

    return this.withSecurityGroups(
      {
        vpc,
        subnetSelection: resolveSubnetSelection(network.options),
      },
      scope,
      idGenerator,
      network.options.securityGroupIds,
    );
  }
}

/**
 * Registry of network resolvers by type
 */
const RESOLVERS: Record<NetworkConfig['type'], NetworkResolver> = {
  subnetIds: new SubnetIdsNetworkResolver(),
  vpcId: new VpcIdNetworkResolver(),
  vpcLookup: new VpcLookupNetworkResolver(),
};

/**
 * Resolve a NetworkConfig into CDK props for CodeBuildStep or codeBuildDefaults.
 * Uses the Strategy pattern to delegate to the appropriate resolver based on network type.
 *
 * @param scope - CDK construct scope
 * @param idGenerator - UniqueId instance for generating unique construct IDs
 * @param network - Network configuration to resolve
 * @returns Resolved network props ready to spread into CDK constructs
 */
export function resolveNetwork(
  scope: Construct,
  idGenerator: UniqueId,
  network: NetworkConfig,
): ResolvedNetwork {
  const resolver = RESOLVERS[network.type];
  return resolver.resolve(scope, idGenerator, network as any);
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
  idGenerator: UniqueId,
  securityGroupIds?: string[],
): ISecurityGroup[] | undefined {
  if (!securityGroupIds?.length) {
    return undefined;
  }
  return securityGroupIds.map(
    (sgId, i) => SecurityGroup.fromSecurityGroupId(scope, idGenerator.generate(`network:sg:${i}`), sgId),
  );
}

/**
 * Unwrap a SecretValue | string into a plain string.
 * When a SecretValue is provided (e.g. from Secrets Manager), calls unsafeUnwrap()
 * to extract the underlying value for use in CDK context lookups.
 */
function resolveSecret(value: SecretValue | string): string {
  return typeof value === 'string' ? value : value.unsafeUnwrap();
}
