import { ISecurityGroup, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator';
import type { SecurityGroupConfig } from './security-group-types';

/**
 * Resolve a SecurityGroupConfig into CDK ISecurityGroup[].
 * Uses discriminated union narrowing to delegate to the appropriate CDK lookup.
 *
 * @param scope - CDK construct scope
 * @param id - UniqueId instance for generating unique construct IDs
 * @param config - Security group configuration to resolve
 * @returns Resolved CDK ISecurityGroup array
 */
export function resolveSecurityGroup(
  scope: Construct,
  id: UniqueId,
  config: SecurityGroupConfig,
): ISecurityGroup[] {
  switch (config.type) {
    case 'securityGroupIds':
      return config.options.securityGroupIds.map(
        (sgId) => SecurityGroup.fromSecurityGroupId(
          scope,
          id.generate('sg:id'),
          sgId,
          { mutable: config.options.mutable },
        ),
      );
    case 'securityGroupLookup': {
      const vpc = Vpc.fromLookup(scope, id.generate('sg:vpc'), {
        vpcId: config.options.vpcId,
      });
      return [
        SecurityGroup.fromLookupByName(
          scope,
          id.generate('sg:lookup'),
          config.options.securityGroupName,
          vpc,
        ),
      ];
    }
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown security group config type: ${(_exhaustive as SecurityGroupConfig).type}`);
    }
  }
}
