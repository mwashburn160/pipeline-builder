import { Effect, IRole, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator';
import type { CodeBuildDefaultRoleOptions, RoleConfig } from './role-types';

/**
 * Resolve a RoleConfig into a CDK IRole.
 * Uses discriminated union narrowing to delegate to the appropriate CDK lookup.
 *
 * @param scope - CDK construct scope
 * @param id - UniqueId instance for generating unique construct IDs
 * @param config - Role configuration to resolve
 * @returns Resolved CDK IRole ready to pass to CodePipeline
 */
export function resolveRole(
  scope: Construct,
  id: UniqueId,
  config: RoleConfig,
): IRole {
  switch (config.type) {
    case 'roleArn':
      return Role.fromRoleArn(scope, id.generate('role:arn'), config.options.roleArn, {
        mutable: config.options.mutable,
      });
    case 'roleName':
      return Role.fromRoleName(scope, id.generate('role:name'), config.options.roleName, {
        mutable: config.options.mutable,
      });
    case 'codeBuildDefault':
      return createCodeBuildDefaultRole(scope, id, config.options);
  }
}

/**
 * Creates a new IAM role with CodeBuild service principal and CloudWatch Logs permissions.
 */
function createCodeBuildDefaultRole(
  scope: Construct,
  id: UniqueId,
  options: CodeBuildDefaultRoleOptions,
): IRole {
  const role = new Role(scope, id.generate('role:codebuild'), {
    assumedBy: new ServicePrincipal('codebuild.amazonaws.com'),
    ...(options.roleName && { roleName: options.roleName }),
  });

  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: ['*'],
    }),
  );

  return role;
}
