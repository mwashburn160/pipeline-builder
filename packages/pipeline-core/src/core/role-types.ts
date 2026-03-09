/**
 * Role configuration using an IAM role ARN
 *
 * Looks up an existing IAM role by its ARN via `Role.fromRoleArn`.
 *
 * @example
 * ```typescript
 * const role: RoleArnConfig = {
 *   type: 'roleArn',
 *   options: {
 *     roleArn: 'arn:aws:iam::123456789012:role/MyPipelineRole',
 *   }
 * };
 * ```
 */
export interface RoleArnConfig {
  readonly type: 'roleArn';
  readonly options: RoleArnOptions;
}

/**
 * Role configuration using an IAM role name
 *
 * Looks up an existing IAM role by its name via `Role.fromRoleName`.
 *
 * @example
 * ```typescript
 * const role: RoleNameConfig = {
 *   type: 'roleName',
 *   options: {
 *     roleName: 'MyPipelineRole',
 *   }
 * };
 * ```
 */
export interface RoleNameConfig {
  readonly type: 'roleName';
  readonly options: RoleNameOptions;
}

/**
 * Configuration options for role lookup by ARN
 */
export interface RoleArnOptions {
  /**
   * Full ARN of the IAM role
   * @example 'arn:aws:iam::123456789012:role/MyPipelineRole'
   */
  readonly roleArn: string;

  /**
   * Whether the imported role can be modified by attaching policy resources to it.
   * Set to false if you know the role is already configured correctly and
   * want to avoid additional API calls during synthesis.
   * @default true
   */
  readonly mutable?: boolean;
}

/**
 * Configuration options for role lookup by name
 */
export interface RoleNameOptions {
  /**
   * Name of the IAM role
   * @example 'MyPipelineRole'
   */
  readonly roleName: string;

  /**
   * Whether the imported role can be modified by attaching policy resources to it.
   * Set to false if you know the role is already configured correctly and
   * want to avoid additional API calls during synthesis.
   * @default true
   */
  readonly mutable?: boolean;
}

/**
 * Role configuration that creates a new IAM role with CodeBuild service principal
 * and minimal CloudWatch Logs permissions.
 *
 * **Important:** This role type uses `codebuild.amazonaws.com` as the trust principal.
 * It is intended for CodeBuild project roles only — do NOT use it as the pipeline-level
 * role (`BuilderProps.role`), which requires `codepipeline.amazonaws.com`. For the
 * pipeline role, use `roleArn` or `roleName` to reference a pre-configured role,
 * or omit `role` entirely to let CDK auto-create one with the correct principal.
 *
 * @example
 * ```typescript
 * const role: CodeBuildDefaultRoleConfig = {
 *   type: 'codeBuildDefault',
 *   options: {},
 * };
 * ```
 */
export interface CodeBuildDefaultRoleConfig {
  readonly type: 'codeBuildDefault';
  readonly options: CodeBuildDefaultRoleOptions;
}

/**
 * Configuration options for creating a CodeBuild service role
 */
export interface CodeBuildDefaultRoleOptions {
  /**
   * Optional custom role name.
   * When omitted, CDK generates a unique name.
   */
  readonly roleName?: string;
}

/**
 * Role configuration using an OIDC identity provider for federated role assumption.
 *
 * Creates a new IAM role that trusts an OpenID Connect provider (e.g. GitHub Actions,
 * GitLab CI, Bitbucket Pipelines) instead of requiring a static role ARN.
 *
 * Provide either `providerArn` to reference an existing OIDC provider,
 * or `issuer` + `clientIds` to create a new one.
 *
 * @example
 * ```typescript
 * // Reference an existing OIDC provider
 * const role: OidcRoleConfig = {
 *   type: 'oidc',
 *   options: {
 *     providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
 *     conditions: {
 *       'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
 *     },
 *   },
 * };
 *
 * // Create a new OIDC provider inline (GitHub Actions)
 * const role: OidcRoleConfig = {
 *   type: 'oidc',
 *   options: {
 *     issuer: 'https://token.actions.githubusercontent.com',
 *     clientIds: ['sts.amazonaws.com'],
 *     thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
 *     conditions: {
 *       'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
 *     },
 *   },
 * };
 * ```
 */
export interface OidcRoleConfig {
  readonly type: 'oidc';
  readonly options: OidcRoleOptions;
}

/**
 * Configuration options for OIDC federated role assumption.
 */
export interface OidcRoleOptions {
  /**
   * ARN of an existing IAM OIDC identity provider.
   * Mutually exclusive with `issuer`.
   * @example 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com'
   */
  readonly providerArn?: string;

  /**
   * OIDC issuer URL for creating a new provider.
   * Mutually exclusive with `providerArn`.
   * @example 'https://token.actions.githubusercontent.com'
   */
  readonly issuer?: string;

  /**
   * Client IDs (audiences) trusted by the OIDC provider.
   * Required when using `issuer` to create a new provider.
   * @example ['sts.amazonaws.com']
   */
  readonly clientIds?: string[];

  /**
   * TLS certificate thumbprints for the OIDC provider.
   * Required when using `issuer` to create a new provider.
   */
  readonly thumbprints?: string[];

  /**
   * StringEquals conditions for the assume-role trust policy.
   * Keys are the condition claim, values are the expected claim value(s).
   * @example { 'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main' }
   */
  readonly conditions?: Record<string, string | string[]>;

  /**
   * StringLike conditions for wildcard matching in the trust policy.
   * @example { 'token.actions.githubusercontent.com:sub': 'repo:my-org/*' }
   */
  readonly conditionsLike?: Record<string, string | string[]>;

  /**
   * Optional custom role name.
   * When omitted, CDK generates a unique name.
   */
  readonly roleName?: string;

  /**
   * Optional description for the IAM role.
   * Appears in the AWS console and API responses.
   * @example 'OIDC role for GitHub Actions CI/CD pipeline'
   */
  readonly description?: string;

  /**
   * Maximum session duration in seconds for the assumed role.
   * Controls how long the temporary credentials remain valid.
   * Must be between 3600 (1 hour) and 43200 (12 hours).
   * @default 3600 (1 hour, AWS default)
   */
  readonly maxSessionDuration?: number;

  /**
   * ARN of an IAM permissions boundary to attach to the role.
   * Required in many enterprise AWS environments to limit maximum permissions.
   * @example 'arn:aws:iam::123456789012:policy/DeveloperBoundary'
   */
  readonly permissionsBoundaryArn?: string;

  /**
   * Optional managed policy ARNs to attach to the role.
   */
  readonly managedPolicyArns?: string[];

  /**
   * Inline IAM policy statements to attach to the role.
   * Each entry defines an IAM policy statement with effect, actions, and resources.
   *
   * @example
   * ```typescript
   * policyStatements: [
   *   { actions: ['s3:GetObject'], resources: ['arn:aws:s3:::my-bucket/*'] },
   *   { actions: ['logs:CreateLogGroup', 'logs:PutLogEvents'], resources: ['*'] },
   * ]
   * ```
   */
  readonly policyStatements?: OidcPolicyStatement[];
}

/**
 * An inline IAM policy statement for OIDC roles.
 */
export interface OidcPolicyStatement {
  /**
   * IAM effect. Defaults to 'Allow'.
   */
  readonly effect?: 'Allow' | 'Deny';

  /**
   * IAM actions (e.g. 's3:GetObject', 'logs:*').
   */
  readonly actions: string[];

  /**
   * IAM resource ARNs this statement applies to.
   */
  readonly resources: string[];
}

/**
 * Union type of all supported role configurations.
 *
 * Used at the pipeline level (`BuilderProps.role`) to specify the IAM role
 * for the CodePipeline construct.
 *
 * Each variant resolves to a CDK `IRole`:
 * - RoleArnConfig: Role looked up by ARN
 * - RoleNameConfig: Role looked up by name
 * - CodeBuildDefaultRoleConfig: Creates a new role with CodeBuild trust + CloudWatch Logs
 * - OidcRoleConfig: Creates a new role with OIDC federated trust (no static ARN needed)
 */
export type RoleConfig = RoleArnConfig | RoleNameConfig | CodeBuildDefaultRoleConfig | OidcRoleConfig;
