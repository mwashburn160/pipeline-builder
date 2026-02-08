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
 * Union type of all supported role configurations.
 *
 * Used at the pipeline level (`BuilderProps.role`) to specify the IAM role
 * for the CodePipeline construct.
 *
 * Each variant resolves to a CDK `IRole`:
 * - RoleArnConfig: Role looked up by ARN
 * - RoleNameConfig: Role looked up by name
 * - CodeBuildDefaultRoleConfig: Creates a new role with CodeBuild trust + CloudWatch Logs
 */
export type RoleConfig = RoleArnConfig | RoleNameConfig | CodeBuildDefaultRoleConfig;
