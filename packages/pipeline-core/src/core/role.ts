import { IRole, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator';
import {
  RoleConfig,
  RoleArnConfig,
  RoleNameConfig,
} from './role-types';

/**
 * Strategy interface for role resolution.
 * Each role type implements this interface to provide custom resolution logic.
 */
interface RoleResolver<T extends RoleConfig = RoleConfig> {
  resolve(scope: Construct, idGenerator: UniqueId, config: T): IRole;
}

/**
 * Resolver for role lookup by ARN
 */
class RoleArnResolver implements RoleResolver<RoleArnConfig> {
  resolve(scope: Construct, idGenerator: UniqueId, config: RoleArnConfig): IRole {
    return Role.fromRoleArn(scope, idGenerator.generate('role:arn'), config.options.roleArn, {
      mutable: config.options.mutable,
    });
  }
}

/**
 * Resolver for role lookup by name
 */
class RoleNameResolver implements RoleResolver<RoleNameConfig> {
  resolve(scope: Construct, idGenerator: UniqueId, config: RoleNameConfig): IRole {
    return Role.fromRoleName(scope, idGenerator.generate('role:name'), config.options.roleName, {
      mutable: config.options.mutable,
    });
  }
}

/**
 * Registry of role resolvers by type
 */
const RESOLVERS: Record<RoleConfig['type'], RoleResolver> = {
  roleArn: new RoleArnResolver(),
  roleName: new RoleNameResolver(),
};

/**
 * Resolve a RoleConfig into a CDK IRole.
 * Uses the Strategy pattern to delegate to the appropriate resolver based on role type.
 *
 * @param scope - CDK construct scope
 * @param idGenerator - UniqueId instance for generating unique construct IDs
 * @param config - Role configuration to resolve
 * @returns Resolved CDK IRole ready to pass to CodePipeline
 */
export function resolveRole(
  scope: Construct,
  idGenerator: UniqueId,
  config: RoleConfig,
): IRole {
  const resolver = RESOLVERS[config.type];
  return resolver.resolve(scope, idGenerator, config as any);
}
