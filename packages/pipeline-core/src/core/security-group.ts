import { ISecurityGroup, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { ConstructId } from './id-generator';
import type { SecurityGroupConfig } from './security-group-types';

/**
 * Resolve a SecurityGroupConfig into CDK ISecurityGroup[].
 * Uses discriminated union narrowing to delegate to the appropriate CDK lookup.
 *
 * @param scope - CDK construct scope
 * @param idGenerator - ConstructId instance for generating unique construct IDs
 * @param config - Security group configuration to resolve
 * @returns Resolved CDK ISecurityGroup array
 */
export function resolveSecurityGroup(
  scope: Construct,
  idGenerator: ConstructId,
  config: SecurityGroupConfig,
): ISecurityGroup[] {
  switch (config.type) {
    case 'securityGroupIds':
      return config.options.securityGroupIds.map(
        (sgId) => SecurityGroup.fromSecurityGroupId(
          scope,
          idGenerator.generate('sg:id'),
          sgId,
          { mutable: config.options.mutable },
        ),
      );
    case 'securityGroupLookup': {
      const vpc = Vpc.fromLookup(scope, idGenerator.generate('sg:vpc'), {
        vpcId: config.options.vpcId,
      });
      return [
        SecurityGroup.fromLookupByName(
          scope,
          idGenerator.generate('sg:lookup'),
          config.options.securityGroupName,
          vpc,
        ),
      ];
    }
  }
}
