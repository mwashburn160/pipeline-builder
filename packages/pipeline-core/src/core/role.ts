import { IRole, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ConstructId } from './id-generator';
import type { RoleConfig } from './role-types';

/**
 * Resolve a RoleConfig into a CDK IRole.
 * Uses discriminated union narrowing to delegate to the appropriate CDK lookup.
 *
 * @param scope - CDK construct scope
 * @param idGenerator - ConstructId instance for generating unique construct IDs
 * @param config - Role configuration to resolve
 * @returns Resolved CDK IRole ready to pass to CodePipeline
 */
export function resolveRole(
  scope: Construct,
  idGenerator: ConstructId,
  config: RoleConfig,
): IRole {
  switch (config.type) {
    case 'roleArn':
      return Role.fromRoleArn(scope, idGenerator.generate('role:arn'), config.options.roleArn, {
        mutable: config.options.mutable,
      });
    case 'roleName':
      return Role.fromRoleName(scope, idGenerator.generate('role:name'), config.options.roleName, {
        mutable: config.options.mutable,
      });
  }
}
