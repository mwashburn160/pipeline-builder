// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ArnFormat, Duration, Stack, Token } from 'aws-cdk-lib';
import {
  Effect,
  type IOpenIdConnectProvider,
  type IRole,
  ManagedPolicy,
  OpenIdConnectPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { UniqueId } from './id-generator.js';
import type { CodeBuildDefaultRoleOptions, OidcRoleOptions, RoleConfig } from './role-types.js';
import { Config } from '../config/app-config.js';

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
      // formatArn emits the stack's partition (aws / aws-cn / aws-us-gov)
      // rather than a hardcoded `arn:aws`.
      resources: [
        stack.formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: `${logGroupPattern}:*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
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

  const trustConditions = buildOidcTrustConditions(options);
  const principal = new OpenIdConnectPrincipal(provider, trustConditions);

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

/**
 * Condition-key prefix IAM uses for an OIDC provider's claims: the issuer URL
 * without its scheme (and without a trailing slash), e.g.
 * `token.actions.githubusercontent.com`. Derived from `issuer`, or from the
 * provider ARN's `oidc-provider/<host>` resource. Returns undefined when the
 * value is an unresolved CDK token (e.g. an imported ARN) and so cannot be
 * inspected at synth.
 */
function oidcConditionHost(options: OidcRoleOptions): string | undefined {
  if (options.issuer) {
    if (Token.isUnresolved(options.issuer)) return undefined;
    return options.issuer.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }
  const arn = options.providerArn;
  if (!arn || Token.isUnresolved(arn)) return undefined;
  return /:oidc-provider\/(.+)$/.exec(arn)?.[1]?.replace(/\/+$/, '');
}

/** True when every value of a condition is a bare wildcard (`*`), i.e. matches any subject. */
function isWildcardOnly(value: string | string[]): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.length === 0 || values.every((v) => /^\*+$/.test(v.trim()));
}

/**
 * Build the trust-policy conditions for an OIDC role, failing closed.
 *
 * Without a `<host>:sub` condition, `sts:AssumeRoleWithWebIdentity` is granted to
 * EVERY token the issuer mints — for GitHub Actions that is any workflow in any
 * repository on github.com. So a subject condition is mandatory, and the
 * audience (`<host>:aud`) is pinned in StringEquals when the caller didn't set it.
 */
function buildOidcTrustConditions(options: OidcRoleOptions): Record<string, Record<string, string | string[]>> {
  const equals: Record<string, string | string[]> = { ...(options.conditions ?? {}) };
  const like: Record<string, string | string[]> = { ...(options.conditionsLike ?? {}) };

  const resolvedHost = oidcConditionHost(options);
  const exampleHost = resolvedHost ?? 'token.actions.githubusercontent.com';
  const isSubKey = (key: string): boolean =>
    resolvedHost ? key === `${resolvedHost}:sub` : key.endsWith(':sub');

  const subEntries = [...Object.entries(equals), ...Object.entries(like)]
    .filter(([key]) => isSubKey(key));

  if (subEntries.length === 0) {
    throw new Error(
      `OIDC role config must restrict the token subject: add a '${exampleHost}:sub' condition ` +
      'to options.conditions (exact match) or options.conditionsLike (wildcards). Without it, ' +
      'any identity the issuer mints a token for (e.g. any GitHub repository) can assume this role. ' +
      "Example: conditions: { 'token.actions.githubusercontent.com:sub': 'repo:acme/app:ref:refs/heads/main' }",
    );
  }
  if (subEntries.every(([, value]) => isWildcardOnly(value))) {
    throw new Error(
      `OIDC role config '${exampleHost}:sub' condition must not be a bare '*' wildcard — it matches ` +
      "every subject. Scope it, e.g. conditionsLike: { 'token.actions.githubusercontent.com:sub': 'repo:acme/*' }",
    );
  }

  // Host for the aud key: the provider's, or (for a tokenized ARN) the prefix of the sub key.
  const host = resolvedHost ?? subEntries[0][0].slice(0, -':sub'.length);
  const audKey = `${host}:aud`;
  if (!(audKey in equals) && !(audKey in like)) {
    // Pin to the provider's trusted audiences (any-of when several), defaulting
    // to the AWS STS audience GitHub/GitLab federation uses.
    const clientIds = options.clientIds?.filter((c) => c.length > 0) ?? [];
    equals[audKey] = clientIds.length === 0
      ? 'sts.amazonaws.com'
      : clientIds.length === 1 ? clientIds[0] : clientIds;
  }

  return {
    ...(Object.keys(equals).length > 0 && { StringEquals: equals }),
    ...(Object.keys(like).length > 0 && { StringLike: like }),
  };
}
