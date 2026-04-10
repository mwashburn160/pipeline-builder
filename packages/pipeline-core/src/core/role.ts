// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Duration, Stack } from 'aws-cdk-lib';
import {
  Effect,
  IOpenIdConnectProvider,
  IRole,
  ManagedPolicy,
  OpenIdConnectPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator';
import type { CodeBuildDefaultRoleOptions, OidcRoleOptions, RoleConfig } from './role-types';
import { Config } from '../config/app-config';

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
    case 'oidc':
      return createOidcRole(scope, id, config.options);
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown role config type: ${(_exhaustive as RoleConfig).type}`);
    }
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

  const stack = Stack.of(scope);
  const logGroupPrefix = Config.get('aws').logging.groupName;
  // Derive ARN pattern from the configured log group name (strip trailing segment for wildcard)
  const logGroupPattern = logGroupPrefix.replace(/\/[^/]*$/, '/*');
  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${stack.region}:${stack.account}:log-group:${logGroupPattern}:*`,
      ],
    }),
  );

  return role;
}

/**
 * Creates a new IAM role with an OIDC federated trust principal.
 *
 * Supports either referencing an existing OIDC provider by ARN
 * or creating a new one from issuer URL + client IDs.
 */
function createOidcRole(
  scope: Construct,
  id: UniqueId,
  options: OidcRoleOptions,
): IRole {
  if (options.providerArn && options.issuer) {
    throw new Error('OIDC role config must specify either providerArn or issuer, not both');
  }

  let provider: IOpenIdConnectProvider;

  if (options.providerArn) {
    provider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      scope,
      id.generate('oidc:provider'),
      options.providerArn,
    );
  } else if (options.issuer) {
    provider = new OpenIdConnectProvider(scope, id.generate('oidc:provider'), {
      url: options.issuer,
      clientIds: options.clientIds ?? ['sts.amazonaws.com'],
      thumbprints: options.thumbprints,
    });
  } else {
    throw new Error('OIDC role config requires either providerArn or issuer');
  }

  const principal = new OpenIdConnectPrincipal(provider, {
    ...(options.conditions && { StringEquals: options.conditions }),
    ...(options.conditionsLike && { StringLike: options.conditionsLike }),
  });

  const role = new Role(scope, id.generate('role:oidc'), {
    assumedBy: principal,
    ...(options.roleName && { roleName: options.roleName }),
    ...(options.description && { description: options.description }),
    ...(options.maxSessionDuration && {
      maxSessionDuration: Duration.seconds(options.maxSessionDuration),
    }),
    ...(options.permissionsBoundaryArn && {
      permissionsBoundary: ManagedPolicy.fromManagedPolicyArn(
        scope,
        id.generate('oidc:boundary'),
        options.permissionsBoundaryArn,
      ),
    }),
  });

  if (options.managedPolicyArns) {
    for (const arn of options.managedPolicyArns) {
      role.addManagedPolicy(ManagedPolicy.fromManagedPolicyArn(scope, id.generate('oidc:policy'), arn));
    }
  }

  if (options.policyStatements) {
    for (const stmt of options.policyStatements) {
      role.addToPolicy(
        new PolicyStatement({
          effect: stmt.effect === 'Deny' ? Effect.DENY : Effect.ALLOW,
          actions: stmt.actions,
          resources: stmt.resources,
        }),
      );
    }
  }

  return role;
}
