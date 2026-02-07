import { ISecurityGroup, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator';
import {
  SecurityGroupConfig,
  SecurityGroupIdsConfig,
  SecurityGroupLookupConfig,
} from './security-group-types';

/**
 * Strategy interface for security group resolution.
 * Each security group type implements this interface to provide custom resolution logic.
 */
interface SecurityGroupResolver<T extends SecurityGroupConfig = SecurityGroupConfig> {
  resolve(scope: Construct, idGenerator: UniqueId, config: T): ISecurityGroup[];
}

/**
 * Resolver for security groups by explicit IDs
 */
class SecurityGroupIdsResolver implements SecurityGroupResolver<SecurityGroupIdsConfig> {
  resolve(scope: Construct, idGenerator: UniqueId, config: SecurityGroupIdsConfig): ISecurityGroup[] {
    return config.options.securityGroupIds.map(
      (sgId, i) => SecurityGroup.fromSecurityGroupId(
        scope,
        idGenerator.generate(`sg:id:${i}`),
        sgId,
        { mutable: config.options.mutable },
      ),
    );
  }
}

/**
 * Resolver for security group lookup by name
 */
class SecurityGroupLookupResolver implements SecurityGroupResolver<SecurityGroupLookupConfig> {
  resolve(scope: Construct, idGenerator: UniqueId, config: SecurityGroupLookupConfig): ISecurityGroup[] {
    const vpc = Vpc.fromLookup(scope, idGenerator.generate('sg:vpc'), {
      vpcId: config.options.vpcId,
    });

    const sg = SecurityGroup.fromLookupByName(
      scope,
      idGenerator.generate('sg:lookup'),
      config.options.securityGroupName,
      vpc,
    );

    return [sg];
  }
}

/**
 * Registry of security group resolvers by type
 */
const RESOLVERS: Record<SecurityGroupConfig['type'], SecurityGroupResolver> = {
  securityGroupIds: new SecurityGroupIdsResolver(),
  securityGroupLookup: new SecurityGroupLookupResolver(),
};

/**
 * Resolve a SecurityGroupConfig into CDK ISecurityGroup[].
 * Uses the Strategy pattern to delegate to the appropriate resolver based on config type.
 *
 * @param scope - CDK construct scope
 * @param idGenerator - UniqueId instance for generating unique construct IDs
 * @param config - Security group configuration to resolve
 * @returns Resolved CDK ISecurityGroup array
 */
export function resolveSecurityGroup(
  scope: Construct,
  idGenerator: UniqueId,
  config: SecurityGroupConfig,
): ISecurityGroup[] {
  const resolver = RESOLVERS[config.type];
  return resolver.resolve(scope, idGenerator, config as any);
}
